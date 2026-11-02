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
    await addFile(page, fixture('real/astronaut.png'));
    const item = await readyItem(page);
    await expect(item.getByTestId('mask-summary')).toContainText('۱ صورت');
    await context.setOffline(false);
  });

  test('switches to English', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pakkon');
  });
});
