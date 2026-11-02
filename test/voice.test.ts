import { describe, expect, it } from 'vitest';
import { PitchShifter, randomVoiceRatio } from '../src/lib/voice';

/** Dominant frequency by counting upward zero crossings. */
function frequency(x: Float32Array, rate: number, skip: number): number {
  let n = 0;
  for (let i = skip + 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++;
  return n / ((x.length - skip) / rate);
}

describe('voice change', () => {
  const rate = 48000;
  const tone = (f: number, seconds: number) => Float32Array.from({ length: rate * seconds }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / rate));

  it('lowers the pitch by the chosen factor and keeps the length', () => {
    const input = tone(220, 2);
    const shifter = new PitchShifter(0.75, rate, 1);
    // Feed in blocks, like decoded audio arrives.
    const parts: Float32Array[] = [];
    for (let o = 0; o < input.length; o += 1024) parts.push(shifter.process([input.subarray(o, o + 1024)])[0]!);
    const out = new Float32Array(input.length);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    expect(out.length).toBe(input.length);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    const f = frequency(out, rate, rate / 10);
    expect(f).toBeGreaterThan(220 * 0.75 * 0.93);
    expect(f).toBeLessThan(220 * 0.75 * 1.07);
    // Loudness stays similar (no silence, no clipping).
    const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
    expect(rms).toBeGreaterThan(0.2);
    expect(Math.max(...out.map(Math.abs))).toBeLessThan(1);
  });

  it('handles several channels and empty blocks', () => {
    const s = new PitchShifter(0.8, rate, 2);
    expect(s.process([new Float32Array(0), new Float32Array(0)])[1]!.length).toBe(0);
    const out = s.process([tone(300, 0.1), tone(300, 0.1)]);
    expect(out).toHaveLength(2);
  });

  it('picks a clearly lower voice at random', () => {
    for (const r of [0, 0.5, 0.999]) {
      const v = randomVoiceRatio(() => r);
      expect(v).toBeGreaterThanOrEqual(0.72);
      expect(v).toBeLessThan(0.82);
    }
    expect(() => new PitchShifter(10, rate, 1)).toThrow();
  });
});
