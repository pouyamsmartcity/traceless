import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { imageLeftovers } from '../src/lib/clean-image';
import { MINIMAL_JFIF, jpegProblems, parseJpeg, stripJpeg } from '../src/lib/jpeg';
import { parsePng, pngProblems, stripPng } from '../src/lib/png';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/leaky/${name}`, import.meta.url)));

describe('stripJpeg', () => {
  it('keeps only picture segments and a fresh JFIF header', async () => {
    const input = fixture('photo-everything.jpg');
    expect(jpegProblems(input).length).toBeGreaterThan(3);
    const out = stripJpeg(input);
    expect(jpegProblems(out)).toEqual([]);
    expect(await imageLeftovers(out, 'image/jpeg')).toEqual([]);
    expect(Array.from(out.subarray(2, 2 + MINIMAL_JFIF.length))).toEqual(Array.from(MINIMAL_JFIF));
    const layout = parseJpeg(out);
    expect(layout.trailing).toBe(0);
    // The compressed picture itself is untouched.
    const scan = (b: Uint8Array) => {
      const s = parseJpeg(b).segments.find((x) => x.marker === 0xda)!;
      return b.subarray(s.start, s.start + s.length);
    };
    expect(Buffer.from(scan(out)).equals(Buffer.from(scan(input)))).toBe(true);
    const text = new TextDecoder('latin1').decode(out);
    for (const s of ['FakePhone', 'Jane', 'Tehran', 'c2pa', 'ftyp', 'secret']) expect(text).not.toContain(s);
  });

  it('rejects files that are not JPEG', () => {
    expect(() => stripJpeg(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('handles a JPEG without EOI by adding one', () => {
    const input = fixture('photo-everything.jpg');
    const { end } = parseJpeg(input);
    const cut = input.subarray(0, end - 2);
    const out = stripJpeg(cut);
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9);
  });
});

describe('stripPng', () => {
  it('keeps only picture chunks and drops bytes after IEND', async () => {
    const input = fixture('screenshot-leaky.png');
    expect(pngProblems(input).length).toBeGreaterThan(1);
    const out = stripPng(input);
    expect(pngProblems(out)).toEqual([]);
    expect(await imageLeftovers(out, 'image/png')).toEqual([]);
    expect(parsePng(out).chunks.map((c) => c.type)).toEqual(expect.arrayContaining(['IHDR', 'IDAT', 'IEND']));
  });
});

describe('extra protection plan', () => {
  it('always fills the whole output with picture (no empty corners)', async () => {
    const { planExtraTransform } = await import('../src/lib/clean-image');
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (const [w, h] of [[4000, 3000], [3000, 4000], [800, 600], [1600, 1600], [5000, 400]] as const) {
      for (let k = 0; k < 50; k++) {
        const p = planExtraTransform(w, h, rand);
        expect(Math.max(p.outW, p.outH)).toBeLessThanOrEqual(1600);
        const deg = Math.abs((p.angle * 180) / Math.PI);
        expect(deg).toBeGreaterThanOrEqual(0.5);
        expect(deg).toBeLessThanOrEqual(1.5);
        // Map each output corner back into the source picture: it must land inside it.
        for (const [x, y] of [[0, 0], [p.outW, 0], [0, p.outH], [p.outW, p.outH]] as const) {
          const dx = (x - p.outW / 2) / p.scale;
          const dy = (y - p.outH / 2) / p.scale;
          const sx = Math.cos(-p.angle) * dx - Math.sin(-p.angle) * dy + w / 2;
          const sy = Math.sin(-p.angle) * dx + Math.cos(-p.angle) * dy + h / 2;
          expect(sx).toBeGreaterThanOrEqual(-0.01);
          expect(sx).toBeLessThanOrEqual(w + 0.01);
          expect(sy).toBeGreaterThanOrEqual(-0.01);
          expect(sy).toBeLessThanOrEqual(h + 0.01);
        }
      }
    }
  });
});
