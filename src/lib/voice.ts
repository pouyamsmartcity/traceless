/**
 * Voice change for videos: a streaming pitch shifter (two crossfaded read heads on a delay line).
 * Pitch and the voice's formants move together, which changes how a voice sounds more than a pitch
 * change alone, while speech stays understandable. The factor is random per video and drifts slowly over
 * time. This makes a voice harder to recognise by ear, but someone who tries can shift it back roughly:
 * it is not protection against a determined listener. Removing the sound is the safe choice.
 *
 * Kept free of browser APIs so it can be unit-tested in Node.
 */

export class PitchShifter {
  private readonly window: number;
  private readonly buffers: Float32Array[];
  private readonly size: number;
  private write = 0;
  private phase = 0;

  /** `ratio` < 1 lowers the voice, > 1 raises it. It may be changed between blocks. */
  constructor(
    public ratio: number,
    sampleRate: number,
    channels: number,
  ) {
    if (!(ratio > 0.25 && ratio < 4)) throw new Error('pitch ratio out of range');
    this.window = Math.max(64, Math.round(sampleRate * 0.04));
    this.size = this.window * 2 + 4;
    this.buffers = Array.from({ length: channels }, () => new Float32Array(this.size));
  }

  private read(buf: Float32Array, delay: number): number {
    let pos = this.write - delay;
    while (pos < 0) pos += this.size;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = buf[i % this.size]!;
    const b = buf[(i + 1) % this.size]!;
    return a + (b - a) * f;
  }

  /** Processes one block of planar samples (one array per channel, equal lengths) and returns the result. */
  process(planes: Float32Array[]): Float32Array[] {
    const n = planes[0]?.length ?? 0;
    const out = planes.map(() => new Float32Array(n));
    const step = (1 - this.ratio) / this.window;
    for (let s = 0; s < n; s++) {
      for (let c = 0; c < planes.length; c++) this.buffers[c]![this.write] = planes[c]![s]!;
      // Two heads half a window apart; a triangular crossfade keeps the loudness constant.
      const p1 = ((this.phase % 1) + 1) % 1;
      const p2 = (p1 + 0.5) % 1;
      const g1 = 1 - Math.abs(2 * p1 - 1);
      const g2 = 1 - Math.abs(2 * p2 - 1);
      const d1 = 1 + p1 * this.window;
      const d2 = 1 + p2 * this.window;
      for (let c = 0; c < planes.length; c++) {
        const buf = this.buffers[c]!;
        out[c]![s] = this.read(buf, d1) * g1 + this.read(buf, d2) * g2;
      }
      this.phase += step;
      this.write = (this.write + 1) % this.size;
    }
    return out;
  }
}

/** A random factor that clearly lowers the voice (0.72 - 0.82). `rand` returns numbers in [0, 1). */
export function randomVoiceRatio(rand: () => number): number {
  return 0.72 + 0.1 * rand();
}
