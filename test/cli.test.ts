import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { check, clean, inspect } from '../src/cli/core';
import { decodePixels, orient, paintSolid } from '../src/cli/image-node';
import { callTool, handle, TOOLS } from '../src/cli/mcp';
import { audioSignature } from '../src/lib/sanitize-video';

const fx = (p: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${p}`, import.meta.url)));
const latin = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
/** Every value the leaky test files carry; none may be left in a safe copy. */
const SECRETS = ['FakePhone', 'FP-SN-0042', 'Jane Reporter', 'secret phone', 'FakeCam', 'Tehran', 'Enghelab', 'Reza', 'bazaar', 'FakeRecorder', 'Lavf', 'Lavc', 'LAME', '35.69'];

describe('command-line and agent tools (no browser)', () => {
  it('inspects photos, videos and voice notes', async () => {
    const photo = await inspect(fx('leaky/photo-everything.jpg'));
    expect(photo.kind).toBe('image');
    expect(photo.leaks.map((l) => l.id)).toEqual(expect.arrayContaining(['gps', 'deviceModel', 'serialNumber', 'owner', 'dateTaken']));
    expect(photo.leaks.find((l) => l.id === 'gps')?.geo?.lat).toBeCloseTo(35.6997, 3);
    const video = await inspect(fx('leaky/video-location.mov'));
    expect(video.kind).toBe('video');
    expect(video.leaks.map((l) => l.id)).toContain('videoLocation');
    const audio = await inspect(fx('leaky/voice-note.mp3'));
    expect(audio.kind).toBe('audio');
    expect(audio.leaks.some((l) => l.value?.includes('Enghelab'))).toBe(true);
  });

  for (const name of ['leaky/photo-everything.jpg', 'leaky/screenshot-leaky.png', 'leaky/video-location.mov', 'leaky/video-location.mp4', 'leaky/voice-memo.m4a', 'leaky/voice-note.mp3', 'leaky/voice-note.ogg', 'leaky/voice-only.mp4']) {
    it(`makes a clean copy of ${name} that passes the independent check`, async () => {
      const r = await clean(fx(name));
      expect(r.removed.length).toBeGreaterThan(0);
      const text = latin(r.bytes);
      for (const s of SECRETS) expect(text, s).not.toContain(s);
      const c = await check(r.bytes);
      expect(c.problems).toEqual([]);
      expect(c.clean).toBe(true);
    });
  }

  it('reports leaky files as not clean', async () => {
    for (const name of ['leaky/photo-everything.jpg', 'leaky/video-location.mp4', 'leaky/voice-note.mp3', 'real/astronaut-pan.mp4']) {
      expect((await check(fx(name))).clean, name).toBe(false);
    }
  });

  it('turns a sideways photo upright and paints solid covers where asked', async () => {
    // photo-everything.jpg is stored 800 x 600 with EXIF orientation 6 (turn right).
    const r = await clean(fx('leaky/photo-everything.jpg'), { covers: [{ x: 100, y: 200, w: 120, h: 90 }, { x: 300, y: 400, w: 100, h: 140, shape: 'ellipse' }], color: '#ff0000' });
    const img = jpeg.decode(r.bytes, { useTArray: true });
    expect([img.width, img.height]).toEqual([600, 800]);
    const at = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    for (const [x, y] of [[105, 205], [215, 285], [160, 245], [350, 470], [350, 405], [350, 535]] as const) {
      const [rr, g, b] = at(x, y);
      expect(rr, `${x},${y}`).toBeGreaterThan(220);
      expect(g! + b!, `${x},${y}`).toBeLessThan(60);
    }
  });

  it('orientations 2-8 move pixels like browsers do', () => {
    // A 3 x 2 picture with distinct pixels: check one corner for every orientation.
    const p = { width: 3, height: 2, data: new Uint8Array(24).map((_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) * 10)) };
    const first = (o: number) => orient(p, o).data[0];
    // Value at output (0,0): 1: px0, 2: px2, 3: px5, 4: px3, 5: px0, 6: px3, 7: px5, 8: px2 (times 10).
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(first)).toEqual([0, 20, 50, 30, 0, 30, 50, 20]);
    expect([orient(p, 6).width, orient(p, 6).height]).toEqual([2, 3]);
  });

  it('never accepts formats it cannot redraw', () => {
    expect(() => decodePixels(fx('leaky/photo-leaky.webp'))).toThrow(/app/);
    const p = { width: 4, height: 4, data: new Uint8Array(64) };
    paintSolid(p, [{ x: -10, y: -10, w: 100, h: 100 }]);
    expect(p.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0))).toBe(true);
  });

  it('finds encoder names hidden in sound frames', () => {
    const enc = new TextEncoder();
    expect(audioSignature(enc.encode('\xff\xfb\x00\x00LAME3.100UUUU'))).toBe('LAME');
    expect(audioSignature(enc.encode('xxLavc60.31.102'))).toBe('Lavc');
    expect(audioSignature(new Uint8Array(400).map((_, i) => (i * 37) % 251))).toBeUndefined();
  });
});

describe('MCP server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pakkon-mcp-'));

  it('introduces itself and lists its tools', async () => {
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect((init!.result as { serverInfo: { name: string } }).serverInfo.name).toBe('pakkon');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((list!.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['inspect_file', 'clean_file', 'check_file']);
    for (const t of TOOLS) expect(t.inputSchema.required).toContain('path');
    expect((await handle({ jsonrpc: '2.0', id: 3, method: 'nope' }))!.error).toMatchObject({ code: -32601 });
    expect((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf' } }))!.error).toMatchObject({ code: -32602 });
  });

  it('cleans a file next to the original and never overwrites anything', async () => {
    const original = join(dir, 'photo.jpg');
    writeFileSync(original, fx('leaky/photo-everything.jpg'));
    const r = await callTool('clean_file', { path: original, covers: [{ x: 10, y: 10, w: 50, h: 50, shape: 'ellipse' }] });
    expect(r.isError).toBeFalsy();
    const out = (r.structuredContent as { output: string }).output;
    expect(out.startsWith(dir)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(original)).toEqual(Buffer.from(fx('leaky/photo-everything.jpg')));
    const checked = await callTool('check_file', { path: out });
    expect((checked.structuredContent as { clean: boolean }).clean).toBe(true);
    // Writing over the original, or over an existing file, is refused.
    expect((await callTool('clean_file', { path: original, output: original })).isError).toBe(true);
    expect((await callTool('clean_file', { path: original, output: out })).isError).toBe(true);
    expect((await callTool('clean_file', { path: original, covers: [{ x: 1, y: 1, w: -5, h: 5 }] })).isError).toBe(true);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('answers errors as tool errors, not crashes', async () => {
    const r = await callTool('inspect_file', { path: join(dir, 'missing.jpg') });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Error/);
  });
});

describe('hardening (production review)', () => {
  it('answers malformed MCP messages without crashing', async () => {
    expect(await handle(null)).toMatchObject({ error: { code: -32600 }, id: null });
    expect(await handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toMatchObject({ error: { code: -32600 } });
    expect(await handle(42)).toMatchObject({ error: { code: -32600 } });
    // A response sent to us, or a notification, needs no answer.
    expect(await handle({ jsonrpc: '2.0', id: 5, result: {} })).toBeUndefined();
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } })).toBeUndefined();
    expect(await handle({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })).toMatchObject({ error: { code: -32600 }, id: null });
    expect(await handle({ jsonrpc: '2.0', id: 'x', method: 'ping' })).toMatchObject({ id: 'x', result: {} });
  });

  it('refuses devices, folders and pipes instead of reading them', async () => {
    const { readInput } = await import('../src/cli/mcp');
    await expect(readInput('/dev/zero')).rejects.toThrow(/regular file/);
    await expect(readInput(tmpdir())).rejects.toThrow(/regular file/);
    expect((await callTool('inspect_file', { path: '/dev/zero' })).isError).toBe(true);
  });

  it('refuses a picture bomb from its header, before decoding', async () => {
    // A valid-looking PNG header announcing 30000 x 30000 pixels (900 megapixels) in a few bytes.
    const png = new Uint8Array(fx('real/astronaut.png').subarray(0, 64));
    new DataView(png.buffer).setUint32(16, 30000);
    new DataView(png.buffer).setUint32(20, 30000);
    const t = Date.now();
    expect(() => decodePixels(png)).toThrow(/too large/);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it('reads picture sizes from headers', async () => {
    const { headerSize } = await import('../src/lib/inspect-image');
    expect(headerSize(fx('real/astronaut.png'))).toEqual({ width: 512, height: 512 });
    expect(headerSize(fx('leaky/photo-everything.jpg'))).toEqual({ width: 800, height: 600 });
    const webp = headerSize(fx('leaky/photo-leaky.webp'));
    expect(webp?.width).toBeGreaterThan(0);
    expect(headerSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('limits video size by the device memory', async () => {
    const { maxMediaBytes } = await import('../src/ui/pipeline');
    expect(maxMediaBytes(8)).toBe(Math.round((8 * 1024 ** 3) / 5));
    expect(maxMediaBytes(16)).toBe(2 * 1024 ** 3);
    expect(maxMediaBytes(undefined)).toBe(1024 ** 3);
    expect(maxMediaBytes(2)).toBeLessThan(500 * 1024 ** 2);
  });
});
