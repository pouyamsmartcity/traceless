import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceFromBytes } from '../src/lib/bytes';
import { inspectVideo, outputBoxProblems } from '../src/lib/bmff';
import { cleanVideo, videoLeftovers } from '../src/lib/clean-video';
import { inspectImage } from '../src/lib/inspect-image';
import { jpegProblems, stripJpeg } from '../src/lib/jpeg';
import { pngProblems, stripPng } from '../src/lib/png';

/**
 * Feeds thousands of randomly damaged files to the readers. They must never hang or crash the page:
 * they either work or throw a normal error. And whenever stripping succeeds, the result must pass the checks.
 */

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/leaky/${name}`, import.meta.url)));

function rng(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function mutate(src: Uint8Array, rand: () => number): Uint8Array {
  const b = new Uint8Array(src);
  const kind = Math.floor(rand() * 4);
  if (kind === 0) {
    // flip random bytes
    const n = 1 + Math.floor(rand() * 16);
    for (let i = 0; i < n; i++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    return b;
  }
  if (kind === 1) return b.subarray(0, Math.floor(rand() * b.length)); // truncate
  if (kind === 2) {
    // overwrite a length field area near the start with extreme values
    const at = Math.floor(rand() * Math.min(b.length - 4, 2048));
    b.set([0xff, 0xff, 0xff, 0xff].map((x) => (rand() < 0.5 ? x : 0)), at);
    return b;
  }
  // duplicate a slice in the middle
  const a = Math.floor(rand() * b.length);
  const len = Math.floor(rand() * 512);
  const out = new Uint8Array(b.length + len);
  out.set(b.subarray(0, a));
  out.set(b.subarray(a, a + len), a);
  out.set(b.subarray(a), a + Math.min(len, b.length - a));
  return out;
}

describe('fuzzing the readers', () => {
  it('JPEG: inspect and strip never hang, and stripped output always passes the checks', async () => {
    const src = fixture('photo-everything.jpg');
    const rand = rng(42);
    const t0 = performance.now();
    for (let i = 0; i < 400; i++) {
      const b = mutate(src, rand);
      await inspectImage(b); // must not throw
      let out: Uint8Array | undefined;
      try {
        out = stripJpeg(b);
      } catch {
        continue;
      }
      expect(jpegProblems(out)).toEqual([]);
    }
    expect(performance.now() - t0).toBeLessThan(30_000);
  });

  it('PNG: inspect and strip never hang, and stripped output always passes the checks', async () => {
    const src = fixture('screenshot-leaky.png');
    const rand = rng(7);
    for (let i = 0; i < 400; i++) {
      const b = mutate(src, rand);
      await inspectImage(b);
      let out: Uint8Array | undefined;
      try {
        out = stripPng(b);
      } catch {
        continue;
      }
      expect(pngProblems(out)).toEqual([]);
    }
  });

  it('WebP: inspection never throws', async () => {
    const src = fixture('photo-leaky.webp');
    const rand = rng(99);
    for (let i = 0; i < 300; i++) await inspectImage(mutate(src, rand));
  });

  it('MP4/MOV: inspection and the output check never throw or hang', async () => {
    for (const [name, seed] of [['video-location.mp4', 1], ['video-location.mov', 2]] as const) {
      const src = fixture(name);
      const rand = rng(seed);
      for (let i = 0; i < 300; i++) {
        const b = mutate(src, rand);
        const r = await inspectVideo(sourceFromBytes(b));
        expect(Array.isArray(r.findings)).toBe(true);
        expect(Array.isArray(outputBoxProblems(b))).toBe(true);
      }
    }
  });

  it('video cleaning of damaged files either fails cleanly or produces a clean file', async () => {
    const src = fixture('video-location.mp4');
    const rand = rng(1234);
    let produced = 0;
    for (let i = 0; i < 150; i++) {
      const b = mutate(src, rand);
      let bytes: Uint8Array;
      const t0 = performance.now();
      try {
        ({ bytes } = await cleanVideo(new Blob([b as BlobPart])));
      } catch {
        expect(performance.now() - t0, `damaged file ${i} took too long to refuse`).toBeLessThan(10_000);
        continue;
      }
      expect(performance.now() - t0, `damaged file ${i} took too long`).toBeLessThan(10_000);
      produced++;
      expect(await videoLeftovers(bytes)).toEqual([]);
      expect(new TextDecoder('latin1').decode(bytes)).not.toContain('FakePhone');
    }
    expect(produced).toBeGreaterThan(0);
  }, 600_000);
});
