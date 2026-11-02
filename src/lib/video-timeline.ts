import { expand, iou, type Rect } from './detect/geometry';

/**
 * Faces and plates found in sampled video frames, and the masks to paint on every frame.
 * Kept free of browser APIs so it can be unit-tested.
 *
 * Safety first: a frame between two samples is covered by the boxes of both neighbouring samples,
 * by boxes interpolated between matching detections (for moving people), and by a margin for motion.
 * A detection is also held for one extra sample, so one missed detection does not uncover a face.
 */

export interface TimedBoxes {
  /** Time of the sampled frame, in seconds. */
  t: number;
  /** Boxes in display pixels of the full-size frame. */
  boxes: Rect[];
}

/** Extra margin around each box, as a share of the box size, to allow for movement between samples. */
const MOTION_MARGIN = 0.25;

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Pairs boxes of two neighbouring samples that are probably the same face or plate. */
export function matchBoxes(a: Rect[], b: Rect[]): [Rect, Rect][] {
  const pairs: { i: number; j: number; score: number }[] = [];
  a.forEach((ra, i) =>
    b.forEach((rb, j) => {
      const ca = center(ra);
      const cb = center(rb);
      const size = Math.max(ra.w, ra.h, rb.w, rb.h);
      const dist = Math.hypot(ca.x - cb.x, ca.y - cb.y) / size;
      const sizeRatio = Math.max(ra.w, rb.w) / Math.max(1, Math.min(ra.w, rb.w));
      // Same object if it overlaps, or moved less than ~2 box sizes and kept a similar size.
      if (iou(ra, rb) > 0.1 || (dist < 2 && sizeRatio < 1.8)) pairs.push({ i, j, score: iou(ra, rb) - dist });
    }),
  );
  pairs.sort((p, q) => q.score - p.score);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: [Rect, Rect][] = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    out.push([a[p.i]!, b[p.j]!]);
  }
  return out;
}

function lerp(a: Rect, b: Rect, f: number): Rect {
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, w: a.w + (b.w - a.w) * f, h: a.h + (b.h - a.h) * f };
}

/** Index of the last sample at or before time t (or -1). Samples must be sorted by time. */
function sampleBefore(samples: TimedBoxes[], t: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t + 1e-6) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The masks to paint on the frame shown at time `t` (seconds), in display pixels of a w x h frame. */
export function masksAt(samples: TimedBoxes[], t: number, w: number, h: number): Rect[] {
  if (!samples.length) return [];
  const i = sampleBefore(samples, t);
  const prev = i >= 0 ? samples[i] : undefined;
  const next = samples[i + 1];
  const out: Rect[] = [];
  const add = (r: Rect) => out.push(expand(r, MOTION_MARGIN, MOTION_MARGIN, w, h));
  // Hold boxes from the two samples on each side: covers one missed detection.
  for (const k of [i - 1, i, i + 1, i + 2]) for (const r of samples[k]?.boxes ?? []) add(r);
  // Follow moving objects between the two nearest samples.
  if (prev && next && next.t > prev.t) {
    const f = Math.min(1, Math.max(0, (t - prev.t) / (next.t - prev.t)));
    for (const [a, b] of matchBoxes(prev.boxes, next.boxes)) add(lerp(a, b, f));
  }
  return out.filter((r) => r.w > 0 && r.h > 0);
}

/** Times (seconds) at which to look for faces: every `step` seconds, plus the very end. */
export function sampleTimes(start: number, end: number, step: number): number[] {
  const times: number[] = [];
  if (!(end > start)) return [start];
  for (let t = start; t < end; t += step) times.push(Math.round(t * 1000) / 1000);
  const last = Math.max(start, end - 0.001);
  if (times[times.length - 1]! < last - step / 4) times.push(last);
  return times;
}
