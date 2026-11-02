import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourceFromBytes } from '../src/lib/bytes';
import { inspectVideo } from '../src/lib/bmff';
import { imageLeftovers } from '../src/lib/clean-image';
import { inspectImage } from '../src/lib/inspect-image';

const fixture = (p: string) => fileURLToPath(new URL(`../test/fixtures/${p}`, import.meta.url));

/** Every request the page makes must go to its own origin (or be a local blob:/data: URL). */
function watchNetwork(page: Page): string[] {
  const foreign: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'blob:' || url.protocol === 'data:') return;
    if (url.origin !== 'http://localhost:4173') foreign.push(req.url());
  });
  return foreign;
}

async function addFile(page: Page, path: string): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(path);
}

async function readyItem(page: Page) {
  const item = page.getByTestId('item').first();
  await expect(item.getByTestId('item-status')).toHaveAttribute('class', /ready/, { timeout: 90_000 });
  return item;
}

async function outputBytes(page: Page): Promise<{ bytes: Uint8Array; name: string }> {
  const save = page.getByTestId('item').first().getByTestId('save');
  const href = await save.getAttribute('href');
  const name = (await save.getAttribute('download')) ?? '';
  const data = await page.evaluate(async (url) => Array.from(new Uint8Array(await (await fetch(url!)).arrayBuffer())), href);
  return { bytes: new Uint8Array(data), name };
}

/** Average colour of a rectangle of the output image, measured in the browser. */
async function regionColor(page: Page, rect: { x: number; y: number; w: number; h: number }) {
  const href = await page.getByTestId('item').first().getByTestId('save').getAttribute('href');
  return page.evaluate(
    async ({ url, rect }) => {
      const img = new Image();
      img.src = url!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data;
      let r = 0, g = 0, b = 0, max = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]!;
        g += d[i + 1]!;
        b += d[i + 2]!;
        max = Math.max(max, d[i]!, d[i + 1]!, d[i + 2]!);
      }
      const n = d.length / 4;
      return { r: r / n, g: g / n, b: b / n, max, width: img.naturalWidth, height: img.naturalHeight };
    },
    { url: href, rect },
  );
}

/** Average colour and brightest channel of a rectangle of the output video at time t (seconds). */
async function videoRegion(page: Page, t: number, rect: { x: number; y: number; w: number; h: number }) {
  const href = await page.getByTestId('item').first().getByTestId('save').getAttribute('href');
  return page.evaluate(
    async ({ url, t, rect }) => {
      const v = document.createElement('video');
      v.muted = true;
      v.src = url!;
      await new Promise((r, e) => {
        v.onloadeddata = r;
        v.onerror = e;
      });
      v.currentTime = t;
      await new Promise((r) => (v.onseeked = r));
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(v, 0, 0);
      const d = ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data;
      let max = 0;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        max = Math.max(max, d[i]!, d[i + 1]!, d[i + 2]!);
        sum += d[i]! + d[i + 1]! + d[i + 2]!;
      }
      return { max, mean: sum / (d.length * 0.75), width: v.videoWidth, height: v.videoHeight };
    },
    { url: href, t, rect },
  );
}

test.describe('Pakkon', () => {
  test('loads in Persian with a strict content security policy', async ({ page }) => {
    const foreign = watchNetwork(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('پاک‌کن');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self'");
    // The policy really blocks other servers.
    const blocked = await page.evaluate(() =>
      fetch('https://example.com/').then(
        () => false,
        () => true,
      ),
    );
    expect(blocked).toBe(true);
    expect(foreign.filter((u) => !u.startsWith('https://example.com'))).toEqual([]);
  });

  test('cleans a leaky photo: shows the leaks, removes them, keeps the picture upright', async ({ page }) => {
    const foreign = watchNetwork(page);
    await page.goto('/');
    await addFile(page, fixture('leaky/photo-everything.jpg'));
    const item = await readyItem(page);
    const findings = item.getByTestId('findings');
    for (const id of ['gps', 'deviceModel', 'serialNumber', 'owner', 'thumbnail', 'contentCredentials', 'motionPhoto', 'editHistory']) {
      await expect(findings.locator(`[data-finding="${id}"]`).first()).toBeVisible();
    }
    // Nearest place is found offline.
    await expect(findings.locator('[data-finding="gps"]').first()).toContainText('کیلومتر');

    const { bytes, name } = await outputBytes(page);
    expect(name).toMatch(/^img-[a-z0-9]{6}\.jpg$/);
    expect(await imageLeftovers(bytes, 'image/jpeg')).toEqual([]);
    expect((await inspectImage(bytes)).findings).toEqual([]);
    const text = new TextDecoder('latin1').decode(bytes);
    for (const s of ['FakePhone', 'Jane', 'Tehran', 'c2pa', 'ftyp']) expect(text).not.toContain(s);

    // The original is 800x600 with orientation 6 (rotate 90° clockwise): the safe copy is stored upright.
    const corner = await regionColor(page, { x: 600 - 40, y: 5, w: 30, h: 30 });
    expect(corner.width).toBe(600);
    expect(corner.height).toBe(800);
    expect(corner.r).toBeGreaterThan(200); // the red marker moved to the top-right corner
    expect(corner.g).toBeLessThan(60);
    expect(foreign).toEqual([]);
  });

  test('cleans PNG screenshots and WebP photos', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('leaky/screenshot-leaky.png'));
    await readyItem(page);
    let out = await outputBytes(page);
    expect(out.name).toMatch(/\.png$/);
    expect(await imageLeftovers(out.bytes, 'image/png')).toEqual([]);

    await page.getByTestId('item').first().getByRole('button', { name: 'حذف از فهرست' }).click();
    await addFile(page, fixture('leaky/photo-leaky.webp'));
    await readyItem(page);
    out = await outputBytes(page);
    expect(out.name).toMatch(/\.jpg$/);
    expect(await imageLeftovers(out.bytes, 'image/jpeg')).toEqual([]);
  });

  test('covers a face with a solid fill', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('real/astronaut.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('mask-summary')).toContainText('۱ صورت');
    // Reference face box (from the reference implementation): x 179-270, y 63-174.
    const face = await regionColor(page, { x: 195, y: 80, w: 60, h: 80 });
    expect(face.max).toBeLessThan(8);
    const outside = await regionColor(page, { x: 20, y: 400, w: 60, h: 60 });
    expect(outside.max).toBeGreaterThan(40);
  });

  test('covers an Iranian licence plate', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('real/iran-truck.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('mask-summary')).toContainText('۱ پلاک');
    // Reference plate box: x 214-267, y 193-210.
    const plate = await regionColor(page, { x: 220, y: 196, w: 40, h: 10 });
    expect(plate.max).toBeLessThan(8);
  });

  test('switching face covering off and on re-renders the copy', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('real/astronaut.png'));
    await readyItem(page);
    await page.getByTestId('opt-faces').uncheck();
    await readyItem(page);
    await expect(page.getByTestId('mask-summary')).toContainText('۰ صورت');
    expect((await regionColor(page, { x: 195, y: 80, w: 60, h: 80 })).max).toBeGreaterThan(40);
    await page.getByTestId('opt-faces').check();
    await readyItem(page);
    expect((await regionColor(page, { x: 195, y: 80, w: 60, h: 80 })).max).toBeLessThan(8);
  });

  test('extra protection makes a smaller, slightly turned copy and still covers the face', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-extra').check();
    await addFile(page, fixture('real/astronaut.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('extra-note')).toBeVisible();
    const out = await outputBytes(page);
    expect(await imageLeftovers(out.bytes, 'image/png')).toEqual([]);
    const face = await regionColor(page, { x: 205, y: 95, w: 40, h: 50 });
    expect(face.width).toBeLessThan(512);
    expect(face.width).toBeGreaterThan(480);
    expect(face.max).toBeLessThan(12);
    // Corners hold picture, not empty background.
    const corner = await regionColor(page, { x: 0, y: 0, w: 4, h: 4 });
    expect(corner.max).toBeGreaterThan(20);
  });

  test('receives photos shared from another app (Android share sheet)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('offline-badge')).toContainText('آمادهٔ کار بدون اینترنت', { timeout: 90_000 });
    const bytes = Array.from(readFileSync(fixture('leaky/photo-everything.jpg')));
    // What the system share sheet does: a form POST to the share target, handled by the offline worker.
    const finalUrl = await page.evaluate(async (data) => {
      const fd = new FormData();
      fd.append('media', new File([new Uint8Array(data)], 'IMG_20260921_183000.jpg', { type: 'image/jpeg' }));
      const r = await fetch('./share-target', { method: 'POST', body: fd });
      return r.url;
    }, bytes);
    expect(finalUrl).toContain('?shared=1');
    await page.goto('/?shared=1');
    const item = await readyItem(page);
    await expect(item.getByTestId('findings').locator('[data-finding="gps"]').first()).toBeVisible();
    const { name } = await outputBytes(page);
    expect(name).not.toContain('IMG_2026');
    // The shared file is never written to storage, and the address bar is cleaned.
    expect(await page.evaluate(async () => (await caches.keys()).filter((k) => !/^pakkon-[0-9a-f]{12}$/.test(k)))).toEqual([]);
    expect(page.url()).not.toContain('shared');
  });

  test('shows a "check before sending" list with the safe copy', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('leaky/screenshot-leaky.png'));
    const item = await readyItem(page);
    await item.getByTestId('checklist').locator('summary').click();
    await expect(item.getByTestId('checklist')).toContainText('سایه');
  });

  test('covers text when asked, and a cover can be removed with one tap', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-text').check();
    await addFile(page, fixture('real/iran-truck.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('mask-summary')).toContainText('نوشته');
    // The camera's date stamp in the top-right corner (reference box x 560-688, y 15-33) is covered.
    expect((await regionColor(page, { x: 575, y: 19, w: 100, h: 10 })).max).toBeLessThan(8);
    // Tap the date-stamp cover in the editor to uncover it again.
    await page.getByTestId('edit').click();
    const canvas = page.locator('.editor-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + (620 / 700) * box.width, box.y + (24 / 524) * box.height);
    await page.getByTestId('editor-done').click();
    await readyItem(page);
    expect((await regionColor(page, { x: 575, y: 19, w: 100, h: 10 })).max).toBeGreaterThan(100);
  });

  test('if face finding fails, the photo is held back until the user covers by hand or confirms', async ({ page, context }) => {
    await context.route(/models\/.*\.onnx/, (route) => route.abort());
    await page.goto('/');
    await addFile(page, fixture('real/astronaut.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('use-anyway')).toBeVisible();
    await expect(item.getByTestId('save')).toHaveCount(0);
    await item.getByTestId('use-anyway').click();
    await expect(item.getByTestId('save')).toBeVisible();
  });

  test('if video covering fails, no video is made unless the user chooses to continue without it', async ({ page, context }) => {
    await context.route(/models\/.*\.onnx/, (route) => route.abort());
    await page.goto('/');
    await addFile(page, fixture('real/astronaut-pan.mp4'));
    const item = page.getByTestId('item').first();
    await expect(item.getByTestId('continue-without')).toBeVisible({ timeout: 90_000 });
    await expect(item.getByTestId('save')).toHaveCount(0);
    await item.getByTestId('continue-without').click();
    await readyItem(page);
    await expect(item.getByTestId('video-masks')).toHaveAttribute('data-state', 'unavailable');
    const { bytes } = await outputBytes(page);
    expect((await inspectVideo(sourceFromBytes(bytes))).findings).toEqual([]);
  });

  test('switching an option off and on quickly ends with a copy that matches the switches', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('real/astronaut.png'));
    await readyItem(page);
    await page.getByTestId('opt-faces').uncheck();
    await page.getByTestId('opt-faces').check();
    await page.getByTestId('opt-extra').check();
    await page.getByTestId('opt-extra').uncheck();
    await readyItem(page);
    await page.waitForTimeout(1500);
    await readyItem(page);
    await expect(page.getByTestId('mask-summary')).toContainText('۱ صورت');
    await expect(page.getByTestId('extra-note')).toHaveCount(0);
    const face = await regionColor(page, { x: 195, y: 80, w: 60, h: 80 });
    expect(face.width).toBe(512);
    expect(face.max).toBeLessThan(8);
  });

  test('offers to cover the status bar of a phone screenshot', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-faces').uncheck();
    await page.getByTestId('opt-plates').uncheck();
    await addFile(page, fixture('real/phone-screenshot.png'));
    const item = await readyItem(page);
    expect((await regionColor(page, { x: 100, y: 20, w: 300, h: 50 })).max).toBeGreaterThan(200); // status text visible
    await item.getByTestId('cover-status-bar').click();
    await readyItem(page);
    await expect(item.getByTestId('cover-status-bar')).toHaveCount(0);
    expect((await regionColor(page, { x: 0, y: 0, w: 1080, h: 120 })).max).toBeLessThan(8);
    expect((await regionColor(page, { x: 100, y: 320, w: 200, h: 60 })).max).toBeGreaterThan(200); // the rest is kept
  });

  test('counts the people in a crowd photo', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('real/astronaut-grid.jpg'));
    const item = await readyItem(page);
    await expect(item.getByTestId('crowd')).toContainText('۱۲');
  });

  test('warns that uncovered signs, writing or plates may reveal the place', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-plates').uncheck();
    await addFile(page, fixture('real/iran-truck.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('location-risk')).toContainText('نوشته');
    await expect(item.getByTestId('location-risk')).toContainText('پلاک');
    await page.getByTestId('opt-plates').check();
    await page.getByTestId('opt-text').check();
    await readyItem(page);
    await expect(item.getByTestId('mask-summary')).toContainText('نوشته');
    await expect(item.getByTestId('location-risk')).toHaveCount(0);
  });

  test('offers the camera on phones only', async ({ page, isMobile }) => {
    await page.goto('/');
    if (isMobile) {
      await expect(page.getByTestId('camera-button')).toBeVisible();
      await expect(page.getByTestId('camera-input')).toHaveAttribute('capture', 'environment');
    } else {
      await expect(page.getByTestId('camera-button')).toHaveCount(0);
    }
  });

  test('shows signs of editing for a received photo', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('leaky/photo-edited.jpg'));
    let item = await readyItem(page);
    for (const id of ['editingSoftware', 'dateMismatch', 'thumbnailDiffers']) {
      await expect(item.locator(`[data-hint="${id}"]`)).toBeVisible();
    }
    // This photo's hidden thumbnail is a different (pink) picture: noticed by comparing the pixels.
    await addFile(page, fixture('leaky/photo-everything.jpg'));
    item = await readyItem(page);
    await expect(item.locator('[data-hint="thumbnailDiffers"]')).toBeVisible();
    // Unedited photos get no edit hints, also with thumbnails of another shape or a mirrored orientation.
    for (const name of ['photo-honest.jpg', 'photo-honest-wide-bars.jpg', 'photo-honest-wide-crop.jpg', 'photo-honest-mirrored.jpg']) {
      await addFile(page, fixture(`leaky/${name}`));
      item = await readyItem(page);
      await expect(item.getByTestId('findings')).toBeVisible();
      await expect(item.getByTestId('hints'), name).toHaveCount(0);
    }
  });

  test('seals the original with a passphrase, and opens it again to prove it is unchanged', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('leaky/photo-everything.jpg'));
    const item = await readyItem(page);
    await item.getByTestId('seal').click();
    await page.getByTestId('passphrase').fill('correct horse battery');
    await page.getByTestId('passphrase-confirm').fill('correct horse batteri');
    await page.getByTestId('passphrase-ok').click();
    await expect(page.locator('.sheet .error')).not.toBeEmpty();
    await page.getByTestId('passphrase-confirm').fill('correct horse battery');
    const download = page.waitForEvent('download');
    await page.getByTestId('passphrase-ok').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^sealed-[a-z0-9]{6}\.pakkon$/);
    const sealedPath = await file.path();
    const sha = createHash('sha256').update(readFileSync(fixture('leaky/photo-everything.jpg'))).digest('hex');
    // A seal code is shown (safe to note down), never the plain fingerprint of the original.
    const note = (await item.getByTestId('sealed-note').innerText()) ?? '';
    const code = /[0-9a-f]{64}/.exec(note)?.[0];
    expect(code).toBeDefined();
    expect(code).not.toBe(sha);
    // The sealed file reveals nothing readable.
    const sealedBytes = readFileSync(sealedPath!);
    expect(sealedBytes.toString('latin1')).not.toContain('FakePhone');

    // Open it with a wrong passphrase, then the right one.
    await page.getByTestId('file-input').setInputFiles({ name: 'evidence.pakkon', mimeType: 'application/octet-stream', buffer: sealedBytes });
    await page.getByTestId('passphrase').fill('not the passphrase');
    await page.getByTestId('passphrase-ok').click();
    await expect(page.getByTestId('sealed-card').first()).toContainText('رمز اشتباه');
    await page.getByTestId('file-input').setInputFiles({ name: 'evidence.pakkon', mimeType: 'application/octet-stream', buffer: sealedBytes });
    await page.getByTestId('passphrase').fill('correct horse battery');
    await page.getByTestId('passphrase-ok').click();
    const card = page.getByTestId('sealed-card').first();
    await expect(card).toContainText('دست نخورده');
    await expect(card).toContainText(code!);
    await expect(card).not.toContainText(sha);
    await expect(card).toContainText('photo-everything.jpg');
  });

  test('offers to cover the chat header (contact name and picture) of a screenshot', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-faces').uncheck();
    await page.getByTestId('opt-plates').uncheck();
    await addFile(page, fixture('real/phone-screenshot.png'));
    const item = await readyItem(page);
    await item.getByTestId('cover-chat-header').click();
    await readyItem(page);
    // The whole top quarter (status bar and header) is covered; once covered, both buttons disappear.
    expect((await regionColor(page, { x: 0, y: 0, w: 1080, h: 260 })).max).toBeLessThan(8);
    await expect(item.getByTestId('cover-chat-header')).toHaveCount(0);
    await expect(item.getByTestId('cover-status-bar')).toHaveCount(0);
    expect((await regionColor(page, { x: 100, y: 320, w: 200, h: 60 })).max).toBeGreaterThan(200);
  });

  test('covers whole people when asked (body, clothes, hair)', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('real/astronaut.png'));
    const item = await readyItem(page);
    // Body visible before; reference person box x 11-368, y 20-507.
    expect((await regionColor(page, { x: 200, y: 380, w: 60, h: 60 })).max).toBeGreaterThan(60);
    await page.getByTestId('opt-people').check();
    await readyItem(page);
    await expect(item.getByTestId('mask-summary')).toContainText('آدم');
    expect((await regionColor(page, { x: 200, y: 380, w: 60, h: 60 })).max).toBeLessThan(8);
    // The background beside the person stays.
    expect((await regionColor(page, { x: 440, y: 60, w: 40, h: 40 })).max).toBeGreaterThan(60);
  });

  test('holding "compare" shows the original, releasing shows the safe copy again', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('real/astronaut.png'));
    const item = await readyItem(page);
    const img = item.getByTestId('output-image');
    const safeSrc = await img.getAttribute('src');
    const button = item.getByTestId('compare');
    await button.hover();
    await page.mouse.down();
    await expect(img).not.toHaveAttribute('src', safeSrc!);
    await page.mouse.up();
    await expect(img).toHaveAttribute('src', safeSrc!);
    // The save link always points at the safe copy.
    await expect(item.getByTestId('save')).toHaveAttribute('href', safeSrc!);
  });

  test('a cover can be drawn by hand', async ({ page }) => {
    await page.goto('/');
    await addFile(page, fixture('leaky/screenshot-leaky.png'));
    await readyItem(page);
    await page.getByTestId('edit').click();
    const canvas = page.locator('.editor-canvas');
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    // Drag across the middle of the picture (400x300 image).
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.8, { steps: 5 });
    await page.mouse.up();
    await page.getByTestId('editor-done').click();
    await readyItem(page);
    await expect(page.getByTestId('mask-summary')).toContainText('۱');
    const region = await regionColor(page, { x: 260, y: 200, w: 20, h: 20 });
    expect(region.max).toBeLessThan(8);
  });

  test('cleans a video: location, device and data track are gone', async ({ page }) => {
    const foreign = watchNetwork(page);
    await page.goto('/');
    await addFile(page, fixture('leaky/video-location.mov'));
    const item = await readyItem(page);
    await expect(item.getByTestId('findings').locator('[data-finding="videoLocation"]').first()).toBeVisible();
    const { bytes, name } = await outputBytes(page);
    expect(name).toMatch(/^vid-[a-z0-9]{6}\.mp4$/);
    const r = await inspectVideo(sourceFromBytes(bytes));
    expect(r.findings).toEqual([]);
    expect(r.tracks.sort()).toEqual(['soun', 'vide']);
    expect(foreign).toEqual([]);
  });

  for (const name of ['astronaut-pan.mp4', 'astronaut-pan-rotated.mp4']) {
    test(`covers a moving face in every part of a video (${name})`, async ({ page }) => {
      const foreign = watchNetwork(page);
      await page.goto('/');
      await addFile(page, fixture(`real/${name}`));
      const item = await readyItem(page);
      await expect(item.getByTestId('video-masks')).toHaveAttribute('data-state', 'covered');
      const { bytes } = await outputBytes(page);
      const r = await inspectVideo(sourceFromBytes(bytes));
      expect(r.findings).toEqual([]);
      expect(r.tracks.sort()).toEqual(['soun', 'vide']);
      // The face moves left by 30 px/s: centre x = 224 - 30t, y = 118 (display pixels of a 400x400 frame).
      for (const t of [0.1, 0.8, 1.5, 2.2, 2.9]) {
        const cx = Math.round(224 - 30 * t);
        const face = await videoRegion(page, t, { x: cx - 20, y: 98, w: 40, h: 40 });
        expect(face.width).toBe(400);
        expect(face.max, `face visible at ${t}s`).toBeLessThan(40);
      }
      // The rest of the picture is still there.
      const corner = await videoRegion(page, 1.5, { x: 300, y: 300, w: 40, h: 40 });
      expect(corner.mean).toBeGreaterThan(30);
      expect(foreign).toEqual([]);
    });
  }

  test('masks line up in a camcorder-style file whose timestamps start late (fast movement)', async ({ page }) => {
    await page.goto('/');
    // MPEG-TS starting at about 1.5 s; the face (centre x = 449 - 150 t, y = 237) crosses the frame quickly.
    await addFile(page, fixture('real/astronaut-fast.m2ts'));
    const item = await readyItem(page);
    await expect(item.getByTestId('video-masks')).toHaveAttribute('data-state', 'covered');
    for (const t of [0.6, 1.2, 1.8, 2.4]) {
      const cx = Math.round(449 - 150 * t);
      const face = await videoRegion(page, t, { x: cx - 20, y: 217, w: 40, h: 40 });
      expect(face.max, `face visible at ${t}s`).toBeLessThan(40);
    }
  });

  test('removes the sound from a video when asked, and offers to remake it after a change', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-mute').check();
    await addFile(page, fixture('real/astronaut-pan.mp4'));
    const item = await readyItem(page);
    await expect(item.getByTestId('muted-note')).toBeVisible();
    const { bytes } = await outputBytes(page);
    expect((await inspectVideo(sourceFromBytes(bytes))).tracks).toEqual(['vide']);
    await expect(item.getByTestId('rebuild')).toHaveCount(0);
    await page.getByTestId('opt-mute').uncheck();
    await item.getByTestId('rebuild').click();
    await readyItem(page);
    await expect(item.getByTestId('muted-note')).toHaveCount(0);
    const again = await outputBytes(page);
    expect((await inspectVideo(sourceFromBytes(again.bytes))).tracks.sort()).toEqual(['soun', 'vide']);
  });

  test('covers text in a video when asked', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-text').check();
    await addFile(page, fixture('real/iran-truck.mp4'));
    const item = await readyItem(page);
    await expect(item.getByTestId('video-masks')).toHaveAttribute('data-state', 'covered');
    // The camera's date stamp (x 560-688, y 15-33) is covered throughout.
    for (const t of [0.2, 1.0, 1.8]) {
      expect((await videoRegion(page, t, { x: 575, y: 19, w: 100, h: 10 })).max, `text visible at ${t}s`).toBeLessThan(40);
    }
  });

  test('changes voices in a video: the sound is kept but its pitch is lower', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-voice').check();
    await addFile(page, fixture('real/astronaut-pan.mp4'));
    const item = await readyItem(page);
    await expect(item.getByTestId('voice-note')).toBeVisible();
    const { bytes } = await outputBytes(page);
    expect((await inspectVideo(sourceFromBytes(bytes))).tracks.sort()).toEqual(['soun', 'vide']);
    // The test video's sound is a 330 Hz tone; measure the pitch of the new sound in the browser.
    const href = await item.getByTestId('save').getAttribute('href');
    const hz = await page.evaluate(async (url) => {
      const buf = await (await fetch(url!)).arrayBuffer();
      const audio = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(buf);
      const x = audio.getChannelData(0);
      const start = Math.floor(audio.sampleRate * 0.3);
      const end = Math.floor(audio.sampleRate * 1.8);
      let n = 0;
      for (let i = start + 1; i < end; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++;
      return n / ((end - start) / audio.sampleRate);
    }, href);
    expect(hz).toBeGreaterThan(330 * 0.7);
    expect(hz).toBeLessThan(330 * 0.84);
  });

  test('if voices cannot be changed here, the user chooses: remove the sound or keep it', async ({ page }) => {
    await page.addInitScript(() => {
      // Simulate a browser without an audio encoder.
      Object.defineProperty(window, 'AudioEncoder', { value: undefined });
    });
    await page.goto('/');
    await page.getByTestId('opt-voice').check();
    await page.getByTestId('opt-faces').uncheck();
    await page.getByTestId('opt-plates').uncheck();
    await addFile(page, fixture('real/astronaut-pan.mp4'));
    const item = page.getByTestId('item').first();
    await expect(item.getByTestId('voice-mute')).toBeVisible({ timeout: 60_000 });
    await expect(item.getByTestId('save')).toHaveCount(0);
    await item.getByTestId('voice-mute').click();
    await readyItem(page);
    await expect(item.getByTestId('muted-note')).toBeVisible();
    const { bytes } = await outputBytes(page);
    expect((await inspectVideo(sourceFromBytes(bytes))).tracks).toEqual(['vide']);
  });

  test('switching faces on while a video is being made: the note tells the truth and offers a remake', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-faces').uncheck();
    await addFile(page, fixture('real/astronaut-pan.mp4'));
    const item = page.getByTestId('item').first();
    await expect(item.getByTestId('item-status')).toHaveAttribute('class', /detecting|cleaning/, { timeout: 30_000 });
    await page.getByTestId('opt-faces').check();
    await readyItem(page);
    // Made without faces covered: the card says so and offers to make it again.
    await expect(item.getByTestId('video-uncovered')).toContainText('صورت');
    await expect(item.getByTestId('rebuild')).toBeVisible();
    expect((await videoRegion(page, 0.1, { x: 204, y: 98, w: 40, h: 40 })).max).toBeGreaterThan(100);
    await item.getByTestId('rebuild').click();
    await readyItem(page);
    await expect(item.getByTestId('video-uncovered')).toHaveCount(0);
    await expect(item.getByTestId('rebuild')).toHaveCount(0);
    expect((await videoRegion(page, 0.1, { x: 204, y: 98, w: 40, h: 40 })).max).toBeLessThan(40);
  });

  test('covers whole people in a video when asked', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-people').check();
    await addFile(page, fixture('real/astronaut-pan.mp4'));
    const item = await readyItem(page);
    await expect(item.getByTestId('video-masks')).toContainText('کل آدم‌ها');
    // The orange suit (well inside the person) is covered throughout.
    for (const t of [0.2, 1.5, 2.8]) {
      expect((await videoRegion(page, t, { x: 150 - Math.round(30 * t), y: 330, w: 50, h: 50 })).max, `body visible at ${t}s`).toBeLessThan(40);
    }
  });

  test('with covering switched off, a video is only re-packaged', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('opt-faces').uncheck();
    await page.getByTestId('opt-plates').uncheck();
    await addFile(page, fixture('real/astronaut-pan.mp4'));
    const item = await readyItem(page);
    await expect(item.getByTestId('video-masks')).toHaveAttribute('data-state', 'off');
    const face = await videoRegion(page, 0.1, { x: 204, y: 98, w: 40, h: 40 });
    expect(face.max).toBeGreaterThan(100);
  });

  test('shows a clear message for a file it cannot open', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really a picture') });
    await expect(page.getByTestId('item-error')).toBeVisible({ timeout: 30_000 });
  });

  test('works offline after the first visit', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByTestId('offline-badge')).toContainText('آمادهٔ کار بدون اینترنت', { timeout: 90_000 });
    await context.setOffline(true);
    await page.reload();
    // Served by the offline worker with isolation headers, so detection can use several cores.
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await addFile(page, fixture('real/astronaut.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('mask-summary')).toContainText('۱ صورت');
    expect((await regionColor(page, { x: 195, y: 80, w: 60, h: 80 })).max).toBeLessThan(8);
    await addFile(page, fixture('leaky/video-location.mp4'));
    await readyItem(page);
    await context.setOffline(false);
  });

  test('switches to English', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pakkon');
  });
});
