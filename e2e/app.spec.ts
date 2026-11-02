import { expect, test, type Page } from '@playwright/test';
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
