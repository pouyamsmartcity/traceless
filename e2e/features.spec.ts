import { expect, test, type Page } from '@playwright/test';
import { openFindings, openMore, setOpt, setStyle } from './ui';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourceFromBytes } from '../src/lib/bytes';
import { inspectVideo } from '../src/lib/bmff';
import { VOICE_DRIFT, VOICE_MIN, VOICE_SPAN } from '../src/lib/voice';

const fixture = (p: string) => fileURLToPath(new URL(`../test/fixtures/${p}`, import.meta.url));

async function readyItem(page: Page, n = 0) {
  const item = page.getByTestId('item').nth(n);
  await expect(item.getByTestId('item-status')).toHaveAttribute('class', /ready/, { timeout: 90_000 });
  return item;
}

async function bytesOf(page: Page, href: string | null): Promise<Uint8Array> {
  return new Uint8Array(await page.evaluate(async (url) => Array.from(new Uint8Array(await (await fetch(url!)).arrayBuffer())), href));
}

/** Pitch of a pure tone in a sound file, by counting zero crossings (measured in the browser). */
async function toneHz(page: Page, href: string | null): Promise<number> {
  return page.evaluate(async (url) => {
    const buf = await (await fetch(url!)).arrayBuffer();
    const audio = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(buf);
    const x = audio.getChannelData(0);
    const start = Math.floor(audio.sampleRate * 0.3);
    const end = Math.floor(audio.sampleRate * 1.6);
    let n = 0;
    for (let i = start + 1; i < end; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++;
    return n / ((end - start) / audio.sampleRate);
  }, href);
}

test.describe('Traceless: new features', () => {
  test.beforeEach(async ({ page }) => {
    // The welcome card is tested on its own; other tests start as a returning visitor.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('fresh')) localStorage.setItem('traceless-intro', 'done');
    });
  });

  for (const name of ['voice-note.ogg', 'voice-note.mp3', 'voice-memo.m4a']) {
    test(`cleans a voice note (${name}): place, speaker and date are gone, the sound stays`, async ({ page }) => {
      await page.goto('/');
      await page.getByTestId('file-input').setInputFiles(fixture(`leaky/${name}`));
      const item = await readyItem(page);
      // What the original told: the place-named title and the speaker.
      await expect(item.getByTestId('findings')).toContainText('Enghelab');
      await expect(item.getByTestId('findings')).toContainText('Reza');
      await expect(item.getByTestId('report')).toBeVisible();
      await expect(item.getByTestId('waveform')).toHaveAttribute('data-drawn', 'true');
      const save = item.getByTestId('save');
      await expect(save).toHaveAttribute('download', /^rec-[a-z0-9]+\.m4a$/);
      const bytes = await bytesOf(page, await save.getAttribute('href'));
      const text = new TextDecoder('latin1').decode(bytes);
      for (const leak of ['Enghelab', 'Reza', 'bazaar', 'FakeRecorder', '35.69', 'Lavf', '2026']) expect(text).not.toContain(leak);
      expect((await inspectVideo(sourceFromBytes(bytes))).tracks).toEqual(['soun']);
      // Same tone as before (voice not changed unless asked).
      expect(Math.abs((await toneHz(page, await save.getAttribute('href'))) - 220)).toBeLessThan(220 * 0.03);
    });
  }

  test('changes the voice in a voice note when asked', async ({ page }) => {
    await page.goto('/');
    await setOpt(page, 'voice', true);
    await page.getByTestId('file-input').setInputFiles(fixture('leaky/voice-note.ogg'));
    const item = await readyItem(page);
    await expect(item.getByTestId('report')).toContainText('صدا تغییر کرد');
    const hz = await toneHz(page, await item.getByTestId('save').getAttribute('href'));
    expect(hz).toBeGreaterThan(220 * (VOICE_MIN - VOICE_DRIFT) * 0.97);
    expect(hz).toBeLessThan(220 * (VOICE_MIN + VOICE_SPAN + VOICE_DRIFT) * 1.03);
    // Switching the voice change off offers to make it again.
    await setOpt(page, 'voice', false);
    await expect(item.getByTestId('rebuild')).toBeVisible();
  });

  test('a damaged voice memo is refused quickly and does not hold up the next file', async ({ page }) => {
    await page.goto('/');
    // Break the sample table (samples per chunk = 2^30), which once made the decoder spin for minutes.
    const bytes = readFileSync(fixture('leaky/voice-memo.m4a'));
    const at = bytes.indexOf(Buffer.from('stsc'));
    bytes.writeUInt32BE(0x40000000, at + 4 + 4 + 4 + 4);
    await page.getByTestId('file-input').setInputFiles({ name: 'broken.m4a', mimeType: 'audio/mp4', buffer: bytes });
    await expect(page.getByTestId('item').first().getByTestId('item-error')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    await readyItem(page, 0);
  });

  test('a voice note inside an .mp4 "video" with no picture is cleaned as a recording', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(fixture('leaky/voice-only.mp4'));
    const item = await readyItem(page);
    await expect(item.getByTestId('save')).toHaveAttribute('download', /^rec-[a-z0-9]+\.m4a$/);
    const text = new TextDecoder('latin1').decode(await bytesOf(page, await item.getByTestId('save').getAttribute('href')));
    for (const leak of ['Enghelab', 'Reza', 'FakeRecorder']) expect(text).not.toContain(leak);
  });

  test('"remove the sound" changes the voice of a voice note instead of leaving it empty', async ({ page }) => {
    await page.goto('/');
    await setOpt(page, 'mute', true);
    await page.getByTestId('file-input').setInputFiles(fixture('leaky/voice-note.ogg'));
    const item = await readyItem(page);
    await expect(item.getByTestId('audio-mute-note')).toBeVisible();
    const hz = await toneHz(page, await item.getByTestId('save').getAttribute('href'));
    expect(hz).toBeLessThan(220 * 0.92);
  });

  test('auto-forget also closes the cover editor, which shows the original', async ({ page }) => {
    await page.clock.install();
    await page.goto('/');
    await setOpt(page, 'autoWipe', true);
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    const item = await readyItem(page);
    await item.getByTestId('edit').click();
    await expect(page.locator('.editor')).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(5 * 60 * 1000 + 100);
    await expect(page.locator('.editor')).toHaveCount(0);
    await expect(page.getByTestId('item')).toHaveCount(0);
  });

  test('auto-forget keeps a photo taken while away (the in-app camera) and forgets the older files', async ({ page }) => {
    await page.clock.install();
    await page.goto('/');
    await setOpt(page, 'autoWipe', true);
    await page.getByTestId('file-input').setInputFiles(fixture('leaky/voice-note.ogg'));
    await readyItem(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(6 * 60 * 1000);
    // The camera hands its photo over just before the page says it is visible again.
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('item')).toHaveCount(1);
    await expect(page.getByTestId('item').first().getByTestId('item-status')).toHaveAttribute('class', /ready/, { timeout: 60_000 });
    await expect(page.getByTestId('item').first().getByTestId('output-image')).toBeVisible();
  });

  test('screen readers hear once when a file is ready, not every percent of progress', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('item')).toHaveCount(0);
    await expect(page.locator('.items[aria-live]')).toHaveCount(0);
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    await readyItem(page);
    await expect(page.getByTestId('announcer')).toHaveText('astronaut.png: نسخهٔ امن آماده است');
  });

  test('protection levels set several switches at once; the page shows what is on', async ({ page }) => {
    await page.goto('/');
    const summary = page.getByTestId('protect-summary');
    await expect(summary.locator('[data-preset]')).toHaveAttribute('data-preset', 'standard');
    await page.getByTestId('open-settings').click();
    await page.getByTestId('preset-max').check();
    for (const k of ['faces', 'plates', 'text', 'people', 'mute', 'extra']) await expect(page.getByTestId(`opt-${k}`)).toBeChecked();
    await expect(page.getByTestId('opt-voice')).not.toBeChecked();
    await page.getByTestId('settings-done').click();
    await expect(summary.locator('[data-preset]')).toHaveAttribute('data-preset', 'max');
    await expect(summary).toContainText('کل آدم‌ها');
    // Changing one switch makes it "custom"; the choice is remembered.
    await setOpt(page, 'people', false);
    await expect(summary.locator('[data-preset]')).toHaveAttribute('data-preset', 'custom');
    await page.reload();
    await expect(summary.locator('[data-preset]')).toHaveAttribute('data-preset', 'custom');
  });

  test('a summary shows what was removed and covered', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(fixture('leaky/photo-everything.jpg'));
    const report = (await readyItem(page)).getByTestId('report');
    for (const kind of ['location', 'device', 'time']) await expect(report.locator(`[data-kind="${kind}"]`)).toBeVisible();
    await expect((await readyItem(page)).getByTestId('size-line')).toContainText('کیلوبایت');
  });

  test('drag across the picture to see the original; letting go shows the safe copy again', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    const item = await readyItem(page);
    const img = item.getByTestId('output-image');
    const safeSrc = await img.getAttribute('src');
    const wrap = item.locator('.preview-wrap.compare');
    const box = (await wrap.boundingBox())!;
    await item.getByTestId('compare').hover();
    await page.mouse.down();
    await expect(wrap).toHaveAttribute('data-revealing', 'true');
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 5 });
    const reveal = await wrap.evaluate((el) => parseFloat(el.style.getPropertyValue('--reveal')));
    expect(reveal).toBeGreaterThan(70);
    // Background checks may refresh the card meanwhile; letting go anywhere brings the safe copy back.
    await page.waitForTimeout(1500);
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await expect(wrap).not.toHaveAttribute('data-revealing', 'true');
    await expect(wrap).toHaveAttribute('style', /--reveal: 0%/);
    // The picture and the save link are always the safe copy.
    await expect(img).toHaveAttribute('src', safeSrc!);
    await expect(item.getByTestId('save')).toHaveAttribute('href', safeSrc!);
  });

  test('sticker look: faces become a smiling yellow sticker, still solid', async ({ page }) => {
    await page.goto('/');
    await setStyle(page, 'sticker');
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    const item = await readyItem(page);
    const href = await item.getByTestId('save').getAttribute('href');
    const stats = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      // A cheek-free patch of the forehead (yellow), and the whole face (a few dark features).
      const fore = ctx.getImageData(212, 72, 26, 10).data;
      let yellow = 0;
      for (let i = 0; i < fore.length; i += 4) if (fore[i]! > 220 && fore[i + 1]! > 180 && fore[i + 2]! < 140) yellow++;
      return { yellowShare: yellow / (fore.length / 4) };
    }, href);
    expect(stats.yellowShare).toBeGreaterThan(0.95);
  });

  test('smaller files: a big photo is made at most 1600 pixels wide', async ({ page }) => {
    await page.goto('/');
    await setOpt(page, 'light', true);
    const big = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 3200;
      c.height = 2000;
      const ctx = c.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, 3200, 2000);
      g.addColorStop(0, '#345');
      g.addColorStop(1, '#fc8');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 3200, 2000);
      const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), 'image/jpeg', 0.95));
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    });
    await page.getByTestId('file-input').setInputFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(big) });
    const item = await readyItem(page);
    const size = await item.getByTestId('output-image').evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    });
    expect(size).toEqual([1600, 1000]);
  });

  test('smaller files: a big video is made at most 1280 pixels wide, still with covers', async ({ page }) => {
    await page.goto('/');
    await setOpt(page, 'light', true);
    // A 1920 x 1080 video with a face in the middle.
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut-1080.mp4'));
    const item = await readyItem(page);
    await expect(item.getByTestId('light-unavailable')).toHaveCount(0);
    const bytes = await bytesOf(page, await item.getByTestId('save').getAttribute('href'));
    expect((await inspectVideo(sourceFromBytes(bytes))).tracks.sort()).toEqual(['soun', 'vide']);
    const dims = await item.locator('video.preview').evaluate(async (v: HTMLVideoElement) => {
      if (v.readyState < 1) await new Promise((r) => (v.onloadedmetadata = r));
      return [v.videoWidth, v.videoHeight];
    });
    expect(dims).toEqual([1280, 720]);
    // The face (centre of the frame) is still covered in the smaller video.
    const spread = await item.locator('video.preview').evaluate(async (v: HTMLVideoElement) => {
      v.currentTime = 0.7;
      await new Promise((r) => (v.onseeked = r));
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(v, 0, 0);
      // astronaut.png face at about (205..245, 95..145) of 512 -> scaled 600/512, centred, then 1280/1920.
      const s = (600 / 512) * (1280 / 1920);
      const x = (1920 - 600) / 2 * (1280 / 1920) + 210 * s;
      const y = (1080 - 600) / 2 * (1280 / 1920) + 100 * s;
      const d = ctx.getImageData(Math.round(x), Math.round(y), Math.round(30 * s), Math.round(35 * s)).data;
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
      }
      return hi - lo;
    });
    expect(spread).toBeLessThan(25);
  });

  test('keeps only a chosen part of a video, with the faces still covered', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut-pan.mp4'));
    let item = await readyItem(page);
    await openMore(item);
    await item.getByTestId('trim-open').click();
    const setRange = (id: string, v: number) =>
      item.getByTestId(id).evaluate((el: HTMLInputElement, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
    await setRange('trim-start', 1);
    await setRange('trim-end', 2.5);
    await item.getByTestId('trim-apply').click();
    item = await readyItem(page);
    await expect(item.getByTestId('trimmed-note')).toBeVisible();
    const video = item.locator('video.preview');
    const duration = await video.evaluate(async (v: HTMLVideoElement) => {
      if (!(v.duration > 0)) await new Promise((r) => (v.onloadedmetadata = r));
      return v.duration;
    });
    expect(duration).toBeGreaterThan(1.3);
    expect(duration).toBeLessThan(1.7);
    // The face moves left by 30 px/s (centre x = 224 - 30t in the original); the new video starts at t = 1 s.
    for (const tt of [0.1, 0.7, 1.3]) {
      const spread = await video.evaluate(async (v: HTMLVideoElement, args) => {
        v.currentTime = args.tt;
        await new Promise((r) => (v.onseeked = r));
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(v, 0, 0);
        const d = ctx.getImageData(Math.round(224 - 30 * (args.tt + 1)) - 20, 98, 40, 40).data;
        let lo = 255;
        let hi = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
          lo = Math.min(lo, l);
          hi = Math.max(hi, l);
        }
        return hi - lo;
      }, { tt });
      expect(spread, `face at ${tt}s`).toBeLessThan(25);
    }
    // Back to the whole video.
    await openMore(item);
    await item.getByTestId('trim-open').click();
    await item.getByTestId('trim-reset').click();
    item = await readyItem(page);
    await expect(item.getByTestId('trimmed-note')).toHaveCount(0);
  });

  test('cuts a video without covering too (the picture is encoded again, so nothing before the cut remains)', async ({ page }) => {
    await page.goto('/');
    await setOpt(page, 'faces', false);
    await setOpt(page, 'plates', false);
    await page.getByTestId('file-input').setInputFiles(fixture('leaky/video-location.mp4'));
    let item = await readyItem(page);
    await openMore(item);
    await item.getByTestId('trim-open').click();
    await item.getByTestId('trim-start').evaluate((el: HTMLInputElement) => {
      el.value = '0.8';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await item.getByTestId('trim-apply').click();
    item = await readyItem(page);
    const duration = await item.locator('video.preview').evaluate(async (v: HTMLVideoElement) => {
      if (!(v.duration > 0)) await new Promise((r) => (v.onloadedmetadata = r));
      return v.duration;
    });
    expect(Math.abs(duration - 1.2)).toBeLessThan(0.15);
    const bytes = await bytesOf(page, await item.getByTestId('save').getAttribute('href'));
    expect((await inspectVideo(sourceFromBytes(bytes))).findings).toEqual([]);
  });

  test('crops a photo in the editor; covers move with the picture', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    let item = await readyItem(page);
    await item.getByTestId('edit').click();
    await page.getByTestId('editor-crop').click();
    const canvas = page.locator('.editor-canvas');
    const box = (await canvas.boundingBox())!;
    // Keep the top-left quarter-and-a-bit: x 100..356, y 40..296 of the 512 x 512 picture (the face is inside).
    const at = (x: number, y: number) => [box.x + (x / 512) * box.width, box.y + (y / 512) * box.height] as const;
    await page.mouse.move(...at(100, 40));
    await page.mouse.down();
    await page.mouse.move(...at(230, 170), { steps: 4 });
    await page.mouse.move(...at(356, 296), { steps: 4 });
    await page.mouse.up();
    await page.getByTestId('editor-done').click();
    item = await readyItem(page);
    await expect(item.getByTestId('cropped-note')).toBeVisible();
    const info = await item.getByTestId('output-image').evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      // The face (205..245, 95..145 in the original) is now at (105..145, 55..105): still one solid colour.
      const d = ctx.getImageData(110, 60, 30, 40).data;
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
      }
      return { w: img.naturalWidth, h: img.naturalHeight, spread: hi - lo };
    });
    expect(Math.abs(info.w - 256)).toBeLessThanOrEqual(3);
    expect(Math.abs(info.h - 256)).toBeLessThanOrEqual(3);
    expect(info.spread).toBeLessThan(6);
  });

  test('files with Persian names work, and the name never reaches the safe copy', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles({ name: 'عکس تظاهرات میدان.png', mimeType: 'image/png', buffer: readFileSync(fixture('real/astronaut.png')) });
    const item = await readyItem(page);
    await expect(page.getByTestId('announcer')).toContainText('عکس تظاهرات میدان.png');
    await expect(item.getByTestId('save')).toHaveAttribute('download', /^img-[a-z0-9]+\.png$/);
  });

  test('a picture bomb (tiny file, gigantic picture) is refused before it is decoded', async ({ page }) => {
    await page.goto('/');
    const png = Buffer.from(readFileSync(fixture('real/astronaut.png')));
    png.writeUInt32BE(30000, 16);
    png.writeUInt32BE(30000, 20);
    await page.getByTestId('file-input').setInputFiles({ name: 'bomb.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('item-error')).toContainText('خیلی بزرگ', { timeout: 15_000 });
  });

  test('a part of the app that can no longer load (site updated meanwhile) offers a reload instead of failing', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError', { cancelable: true })));
    await expect(page.getByTestId('update-bar')).toBeVisible();
    await expect(page.getByTestId('update-reload')).toBeVisible();
  });

  test('when served offline, no other site may show the app inside a frame', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('offline-badge')).toContainText('آمادهٔ کار بدون اینترنت', { timeout: 90_000 });
    await page.reload();
    const headers = await page.evaluate(async () => {
      const r = await fetch('./');
      return { csp: r.headers.get('content-security-policy'), xfo: r.headers.get('x-frame-options') };
    });
    expect(headers.csp).toContain("frame-ancestors 'none'");
    expect(headers.xfo).toBe('DENY');
  });

  test('wipe: one tap forgets every file and copy', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut.png'));
    const href = await (await readyItem(page)).getByTestId('save').getAttribute('href');
    await page.getByTestId('wipe').click();
    await expect(page.getByTestId('item')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toContainText('پاک شد');
    // The safe copy's memory is released: its address no longer works.
    const stillThere = await page.evaluate(async (url) => fetch(url!).then(() => true, () => false), href);
    expect(stillThere).toBe(false);
  });

  test('auto-forget: everything is wiped after five minutes in the background', async ({ page }) => {
    await page.clock.install();
    await page.goto('/');
    await setOpt(page, 'autoWipe', true);
    await page.getByTestId('file-input').setInputFiles(fixture('leaky/voice-note.ogg'));
    await readyItem(page);
    const setVisibility = (state: 'hidden' | 'visible') =>
      page.evaluate((s) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await setVisibility('hidden');
    await page.clock.runFor(4 * 60 * 1000);
    await expect(page.getByTestId('item')).toHaveCount(1);
    await page.clock.runFor(60 * 1000 + 100);
    await setVisibility('visible');
    await expect(page.getByTestId('item')).toHaveCount(0);
  });

  test('saves every safe copy in one ZIP file, without real dates', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles([fixture('real/astronaut.png'), fixture('leaky/photo-everything.jpg')]);
    await readyItem(page, 0);
    await readyItem(page, 1);
    const names = await page.getByTestId('save').evaluateAll((as) => as.map((a) => a.getAttribute('download')).sort());
    const download = page.waitForEvent('download');
    await page.getByTestId('save-zip').click();
    const path = await (await download).path();
    const out = execFileSync('python3', [
      '-I',
      '-c',
      'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(sorted([[i.filename,list(i.date_time)] for i in z.infolist()])))',
      path,
    ]).toString();
    expect(JSON.parse(out)).toEqual(names.map((n) => [n, [1980, 1, 1, 0, 0, 0]]));
  });

  test('videos get a filmstrip; tapping a frame jumps there', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(fixture('real/astronaut-pan.mp4'));
    const item = await readyItem(page);
    const frames = item.getByTestId('filmstrip').locator('.frame');
    await expect(frames).toHaveCount(8, { timeout: 30_000 });
    const t = Number(await frames.nth(5).getAttribute('data-time'));
    await frames.nth(5).click();
    const now = await item.locator('video.preview').evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(Math.abs(now - t)).toBeLessThan(0.05);
  });

  test('first visit: a short welcome that stays closed once dismissed', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('fresh', '1'));
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('traceless-intro'));
    await page.reload();
    await expect(page.getByTestId('intro')).toBeVisible();
    await page.getByTestId('intro-done').click();
    await expect(page.getByTestId('intro')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('intro')).toHaveCount(0);
  });

  test('light and dark looks can be chosen and are remembered', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--surface').trim());
    expect(bg).toBe('#141e1b');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
