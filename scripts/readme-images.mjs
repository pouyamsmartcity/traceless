// Makes the pictures in docs/images/ (README screenshots, before/after, a short demo animation) from the real app.
// Run after `npm run build`: node scripts/readme-images.mjs (needs ffmpeg for the animation).
// The demo photo is the public-domain NASA portrait from test/fixtures/real/astronaut.png with the fake hidden data
// of test/fixtures/leaky/photo-everything.jpg; nothing personal is shown.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { chromium, devices } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'docs/images');
const PORT = 4179;
const BASE = `http://localhost:${PORT}/`;
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'traceless-readme-'));

/** The astronaut portrait as a phone-like JPEG carrying the fake leaks (GPS, phone, serial, owner, dates...). */
function demoPhoto() {
  const png = PNG.sync.read(readFileSync(join(ROOT, 'test/fixtures/real/astronaut.png')));
  const pixels = jpeg.encode({ width: png.width, height: png.height, data: png.data }, 92).data;
  const leaky = readFileSync(join(ROOT, 'test/fixtures/leaky/photo-everything.jpg'));
  const segments = [];
  let i = 2;
  for (;;) {
    const marker = leaky[i + 1];
    const len = leaky.readUInt16BE(i + 2);
    if (marker === 0xda) break;
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) segments.push(Buffer.from(leaky.subarray(i, i + 2 + len)));
    i += 2 + len;
  }
  // Whatever follows the end of the leaky picture (a Motion Photo style video) goes after ours too.
  const end = leaky.lastIndexOf(Buffer.from([0xff, 0xd9]), leaky.indexOf(Buffer.from('ftyp')) > 0 ? leaky.indexOf(Buffer.from('ftyp')) : undefined);
  const trailer = end > 0 ? leaky.subarray(end + 2) : Buffer.alloc(0);
  // Our pixels are already upright: the leaky file's orientation tag (big-endian EXIF) is set to "normal".
  for (const seg of segments) {
    const tag = seg.indexOf(Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]));
    if (tag > 0) seg.writeUInt16BE(1, tag + 8);
  }
  const body = Buffer.from(pixels);
  return Buffer.concat([body.subarray(0, 2), ...segments, body.subarray(2), trailer]);
}

const photo = join(work, 'IMG_2026.jpg');
writeFileSync(photo, demoPhoto());

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
for (let t = 0; ; t++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {}
  if (t > 100) throw new Error('preview server did not start');
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
const phone = { ...devices['Pixel 7'], deviceScaleFactor: 2 };

async function open(lang, opts = {}) {
  // Still pictures: no animations half-way.
  const context = await browser.newContext({ ...phone, reducedMotion: 'reduce', ...opts, locale: { en: 'en-US', fa: 'fa-IR', tr: 'tr-TR' }[lang] });
  await context.addInitScript(() => localStorage.setItem('traceless-intro', 'done'));
  const page = await context.newPage();
  await page.goto(BASE);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

async function addDemo(page) {
  await page.getByTestId('file-input').setInputFiles(photo);
  const item = page.getByTestId('item').first();
  await item.getByTestId('item-status').and(page.locator('.ready')).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(400);
  return item;
}

async function shot(page, name, opts = {}) {
  const file = join(work, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  // JPEG keeps the pictures small enough for a README page.
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', file, '-q:v', '3', join(OUT, `${name}.jpg`)]);
  console.log(`docs/images/${name}.jpg`);
}

// 1. Home screen, in each language.
for (const lang of ['en', 'fa', 'tr']) {
  const { context, page } = await open(lang);
  await shot(page, `home-${lang}`);
  await context.close();
}

// 2. A cleaned photo: what it revealed, what was covered.
for (const lang of ['en', 'fa', 'tr']) {
  const { context, page } = await open(lang);
  const item = await addDemo(page);
  // The card from its top (just under the sticky header): the safe copy and the list of what was removed.
  await item.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
  await page.waitForTimeout(300);
  await shot(page, `result-${lang}`);
  await context.close();
}

// 3. The settings sheet (protection levels) and the cover editor.
{
  const { context, page } = await open('en');
  await page.getByTestId('open-settings').click();
  await page.waitForTimeout(400);
  await shot(page, 'settings-en');
  await page.getByTestId('settings-done').click();
  const item = await addDemo(page);
  await item.getByTestId('edit').click();
  await page.waitForTimeout(600);
  await shot(page, 'editor-en');
  await context.close();
}

// 4. Desktop, dark look: a crowd photo and a voice note.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'en-US' });
  await context.addInitScript(() => localStorage.setItem('traceless-intro', 'done'));
  const page = await context.newPage();
  await page.goto(BASE);
  // The newest file is shown first: a crowd photo (12 faces) above a voice note.
  await page.getByTestId('file-input').setInputFiles([join(ROOT, 'test/fixtures/leaky/voice-note.ogg'), join(ROOT, 'test/fixtures/real/astronaut-grid.jpg')]);
  for (const n of [0, 1]) await page.getByTestId('item').nth(n).getByTestId('item-status').and(page.locator('.ready')).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  // The cards, without the empty sides of a wide screen.
  const top = await page.locator('section.items').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.waitForTimeout(500);
  await shot(page, 'desktop-dark', { clip: { x: 240, y: top - 16, width: 800, height: 1150 } });
  await context.close();
}

// 5. Before and after, side by side: the original with what it was hiding, and the safe copy.
{
  const { context, page } = await open('en');
  const item = await addDemo(page);
  const safe = await item.getByTestId('output-image').evaluate(async (img) => {
    const blob = await (await fetch(img.src)).blob();
    return new Uint8Array(await blob.arrayBuffer());
  });
  const findings = await item.getByTestId('findings').locator('li').allInnerTexts();
  await context.close();
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const font = readFileSync(join(ROOT, 'node_modules/vazirmatn/fonts/webfonts/Vazirmatn[wght].woff2')).toString('base64');
  // The leaks people understand first.
  const order = ['GPS', 'model', 'serial', 'Owner', 'Date', 'video', 'C2PA'];
  const rank = (f) => {
    const k = order.findIndex((w) => f.includes(w));
    return k < 0 ? order.length : k;
  };
  findings.sort((a, b) => rank(a) - rank(b));
  const leaks = findings.slice(0, 7).map((f) => `<li>${f.replace(/</g, '&lt;')}</li>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: V; src: url(data:font/woff2;base64,${font}); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; } body { width: 1200px; font-family: V, sans-serif; background: #f3f6f4; color: #13201b; padding: 36px; }
.row { display: flex; gap: 28px; align-items: stretch; } .card { flex: 1; background: #fff; border-radius: 24px; padding: 22px; box-shadow: 0 8px 24px rgba(16,40,32,.08); }
h2 { font-size: 26px; margin-bottom: 14px; } .bad h2 { color: #b3261e; } .good h2 { color: #0f6b59; }
img { width: 100%; border-radius: 16px; display: block; } ul { margin-top: 14px; padding-left: 22px; font-size: 17px; line-height: 1.6; color: #56655f; }
.arrow { align-self: center; font-size: 48px; color: #0f6b59; }
</style><div class="row">
<div class="card bad"><h2>Before: the photo you took</h2><img src="data:image/jpeg;base64,${b64(readFileSync(photo))}"><ul>${leaks}</ul></div>
<div class="arrow">→</div>
<div class="card good"><h2>After: the safe copy</h2><img src="data:image/jpeg;base64,${b64(safe)}"><ul><li>No location, device, time or other hidden data</li><li>Face covered with a solid fill (not blur)</li><li>Made on the device, nothing uploaded</li><li>Checked again before it is offered</li></ul></div>
</div>`;
  const tab = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  await tab.setContent(html);
  await tab.evaluate(() => document.fonts.ready);
  await shot(tab, 'before-after', { fullPage: true });
  await tab.close();
}

// 6. A short animation: choose a photo, compare the safe copy with the original, see what it revealed.
{
  const videoDir = join(work, 'video');
  const context = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1, locale: 'en-US', recordVideo: { dir: videoDir, size: { width: 412, height: 915 } } });
  await context.addInitScript(() => localStorage.setItem('traceless-intro', 'done'));
  const began = Date.now();
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByTestId('open-settings').waitFor();
  await page.waitForTimeout(600);
  // The recording starts with the page still loading: the animation starts once the app is showing.
  const skip = (Date.now() - began) / 1000;
  await page.waitForTimeout(1000);
  await page.getByTestId('file-input').setInputFiles(photo);
  const item = page.getByTestId('item').first();
  await item.getByTestId('item-status').and(page.locator('.ready')).waitFor({ timeout: 90_000 });
  await item.getByTestId('output-image').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await page.waitForTimeout(1600);
  const handle = item.getByTestId('compare');
  const box = await handle.boundingBox();
  const frame = await item.getByTestId('output-image').boundingBox();
  if (box && frame) {
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    for (let k = 0; k <= 24; k++) await page.mouse.move(frame.x + frame.width * (0.5 - (0.42 * k) / 24), y);
    await page.waitForTimeout(500);
    for (let k = 0; k <= 36; k++) await page.mouse.move(frame.x + frame.width * (0.08 + (0.84 * k) / 36), y);
    await page.waitForTimeout(500);
    for (let k = 0; k <= 16; k++) await page.mouse.move(frame.x + frame.width * (0.92 - (0.42 * k) / 16), y);
    await page.mouse.up();
  }
  await page.waitForTimeout(800);
  const toggle = item.getByTestId('findings-toggle');
  await toggle.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  await page.waitForTimeout(900);
  await toggle.click();
  await page.waitForTimeout(2500);
  await context.close();
  const webm = join(videoDir, readdirSync(videoDir)[0]);
  const palette = join(work, 'palette.png');
  const filters = 'fps=10,scale=320:-1:flags=lanczos';
  const cut = ['-ss', skip.toFixed(2)];
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...cut, '-i', webm, '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...cut, '-i', webm, '-i', palette, '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`, join(OUT, 'demo.gif')]);
  console.log('docs/images/demo.gif');
}

await browser.close();
server.kill();
rmSync(work, { recursive: true, force: true });
