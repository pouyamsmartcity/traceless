import { expand, iou, type Rect } from './detect/geometry';
import type { Cover, Silhouette } from './masks';

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
  /** Covers in display pixels of the full-size frame (shape kept: faces are ellipses). */
  boxes: (Rect & { shape?: Cover['shape']; color?: Cover['color']; silhouette?: Silhouette })[];
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Pairs boxes of two neighbouring samples that are probably the same face or plate. */
export function matchBoxes<T extends Rect>(a: T[], b: T[], maxDist = 2): [T, T][] {
  const pairs: { i: number; j: number; score: number }[] = [];
  a.forEach((ra, i) =>
    b.forEach((rb, j) => {
      const ca = center(ra);
      const cb = center(rb);
      const size = Math.max(ra.w, ra.h, rb.w, rb.h);
      const dist = Math.hypot(ca.x - cb.x, ca.y - cb.y) / size;
      const sizeRatio = Math.max(ra.w, rb.w) / Math.max(1, Math.min(ra.w, rb.w));
      // Same object if it overlaps, or moved less than `maxDist` box sizes and kept a similar size.
      if (iou(ra, rb) > 0.1 || (dist < maxDist && sizeRatio < 1.8)) pairs.push({ i, j, score: iou(ra, rb) - dist });
    }),
  );
  pairs.sort((p, q) => q.score - p.score);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: [T, T][] = [];
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

type TBox = TimedBoxes['boxes'][number];

/** One face, plate or person followed through the video: its boxes at the sampled times. */
interface Track {
  points: { t: number; box: TBox }[];
}

/** Faces link only to faces; a person outlined in one sample and boxed in the next is still one person. */
function family(b: TBox): 'ellipse' | 'other' {
  return b.shape === 'ellipse' ? 'ellipse' : 'other';
}

/**
 * Silhouette cells added around a person's outline in videos: between two samples arms and legs move,
 * so the outline used is the union of both neighbouring outlines, grown by this many cells (of 160).
 */
export const SILHOUETTE_GROW = 8;

/** Union of two silhouettes of the same size (each relative to its own box), grown by `grow` cells. */
export function blendSilhouettes(a: Silhouette, b: Silhouette, grow: number): Silhouette {
  if (a.w !== b.w || a.h !== b.h) throw new Error('silhouette sizes differ');
  const { w, h } = a;
  const both = new Uint8Array(w * h);
  for (let i = 0; i < both.length; i++) both[i] = a.data[i] || b.data[i] ? 1 : 0;
  return { w, h, data: grow > 0 ? dilate(both, w, h, grow) : both };
}

/** Grows the marked cells by r in every direction (square neighbourhood, two separable passes). */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    // Left to right, then right to left: a cell is on if a marked cell is within r along the row.
    for (let x = 0; x < w; x++) {
      if (src[y * w + x]) last = x;
      if (x - last <= r) row[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (src[y * w + x]) last = x;
      if (last - x <= r) row[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (row[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (row[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Blended outlines are reused for every frame between the same two samples. */
const blendCache = new WeakMap<Silhouette, WeakMap<Silhouette, Silhouette>>();

function blendedOutline(a: Silhouette, b: Silhouette): Silhouette {
  let inner = blendCache.get(a);
  if (!inner) blendCache.set(a, (inner = new WeakMap()));
  let s = inner.get(b);
  if (!s) inner.set(b, (s = blendSilhouettes(a, b, SILHOUETTE_GROW)));
  return s;
}

/** Up to this many samples in a row may miss an object before its track ends. */
const MAX_GAP = 2;

/**
 * Links the detections of all samples into tracks (one per face, plate or person), so each object gets one
 * cover that moves with it, instead of a pile of covers from neighbouring samples.
 */
export function buildTracks(samples: TimedBoxes[]): Track[] {
  const tracks: Track[] = [];
  const lastIndex: number[] = [];
  samples.forEach((sample, k) => {
    const open = tracks.map((_, i) => i).filter((i) => k - lastIndex[i]! <= MAX_GAP + 1);
    const unmatched = new Set(sample.boxes.map((_, j) => j));
    // Prefer tracks seen most recently, and only link covers of the same shape (a face to a face).
    for (const gap of [1, 2, 3]) {
      const candidates = open.filter((i) => k - lastIndex[i]! === gap);
      const lastBoxes = candidates.map((i) => tracks[i]!.points[tracks[i]!.points.length - 1]!.box);
      const fresh = [...unmatched].map((j) => sample.boxes[j]!);
      // A fast face can move a few of its own widths between samples (more across missed samples).
      for (const [a, b] of matchBoxes(lastBoxes, fresh, 4 * gap)) {
        if (family(a) !== family(b)) continue;
        const ti = candidates[lastBoxes.indexOf(a)]!;
        const bj = sample.boxes.indexOf(b);
        if (!unmatched.has(bj)) continue;
        tracks[ti]!.points.push({ t: sample.t, box: b });
        lastIndex[ti] = k;
        unmatched.delete(bj);
      }
    }
    for (const j of unmatched) {
      tracks.push({ points: [{ t: sample.t, box: sample.boxes[j]! }] });
      lastIndex.push(k);
    }
  });
  return tracks;
}

const trackCache = new WeakMap<TimedBoxes[], { tracks: Track[]; step: number; first: number; last: number }>();

function tracksOf(samples: TimedBoxes[]) {
  let c = trackCache.get(samples);
  if (!c) {
    const gaps = samples.slice(1).map((s, i) => s.t - samples[i]!.t).sort((a, b) => a - b);
    const step = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 1 / 3;
    c = { tracks: buildTracks(samples), step, first: samples[0]!.t, last: samples[samples.length - 1]!.t };
    trackCache.set(samples, c);
  }
  return c;
}

/**
 * The covers to paint on the frame shown at time `t` (seconds), in display pixels of a w x h frame.
 * Each tracked object gets one cover: interpolated between its samples, carried on in its direction of
 * motion for a short while after it was last seen (up to the end of the video if no later sample exists),
 * and grown by a margin that depends on how fast it moves, so it never slips out from under its cover.
 */
export function masksAt(samples: TimedBoxes[], t: number, w: number, h: number): Cover[] {
  if (!samples.length) return [];
  const { tracks, step, first, last } = tracksOf(samples);
  const hold = step * (MAX_GAP + 0.5);
  const out: Cover[] = [];
  for (const tr of tracks) {
    const p = tr.points;
    const t0 = p[0]!.t;
    const t1 = p[p.length - 1]!.t;
    const before = t0 <= first + 1e-6 ? Infinity : hold;
    const after = t1 >= last - 1e-6 ? Infinity : hold;
    if (t < t0 - before || t > t1 + after) continue;
    // Position: interpolate between samples, or carry on from the nearest end.
    let box: Rect;
    let speed = 0; // pixels per second
    let j = 0;
    while (j < p.length - 1 && p[j + 1]!.t < t) j++;
    const a = p[j]!;
    const b = p[Math.min(j + 1, p.length - 1)]!;
    const dt = b.t - a.t;
    if (dt > 0) {
      const ca = center(a.box);
      const cb = center(b.box);
      speed = Math.hypot(cb.x - ca.x, cb.y - ca.y) / dt;
      const f = Math.min(1, Math.max(0, (t - a.t) / dt));
      box = lerp(a.box, b.box, f);
      // Beyond the ends: keep moving the same way for the time being held.
      const beyond = t < a.t ? t - a.t : t > b.t ? t - b.t : 0;
      if (beyond) box = { ...box, x: box.x + ((cb.x - ca.x) / dt) * beyond, y: box.y + ((cb.y - ca.y) / dt) * beyond };
    } else {
      box = a.box;
    }
    const size = Math.max(1, Math.min(box.w, box.h));
    // Interpolation follows the motion, so only a small margin is needed between samples; carried on
    // beyond the last sample, the margin grows with speed. Seen only once (motion unknown): be generous.
    const away = t < t0 ? t0 - t : t > t1 ? t - t1 : 0;
    const margin =
      p.length === 1
        ? 0.35
        : Math.min(0.6, 0.06 + (speed * (step * 0.15 + 0.5 * Math.min(away, hold))) / size);
    const c: Cover = { ...expand(box, margin, margin, w, h), shape: a.box.shape === 'ellipse' ? 'ellipse' : 'rounded' };
    // A person keeps their outline only while both neighbouring samples have one; otherwise the whole box.
    const sa = a.box.silhouette;
    const sb = b.box.silhouette;
    if (a.box.shape === 'silhouette' && sa && sb && sa.w === sb.w && sa.h === sb.h) {
      // Not clamped to the frame: the outline is drawn relative to the whole (grown) box.
      Object.assign(c, { x: box.x - box.w * margin, y: box.y - box.h * margin, w: box.w * (1 + 2 * margin), h: box.h * (1 + 2 * margin) });
      c.shape = 'silhouette';
      c.silhouette = blendedOutline(sa, sb);
    }
    if (a.box.color) c.color = a.box.color;
    out.push(c);
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
