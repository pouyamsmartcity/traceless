import { iou, type Rect } from './detect/geometry';
import { ELLIPSE_REACH, type Cover, type Silhouette } from './masks';

/**
 * Faces, plates, text and people found in sampled video frames, and the covers to paint on every frame.
 * Kept free of browser APIs so it can be unit-tested.
 *
 * Each object is followed through the samples (a track) and gets one cover per frame: placed where the object
 * should be at that moment (interpolated between samples, carried on in its direction of motion beyond them),
 * and grown by a margin with a fixed part, a part for hand shake and walking bob that sampling cannot see (in
 * pixels of the frame, so small faces get relatively more), a part for how irregularly the object moves
 * (turning, stopping), and a part that grows the longer it has not been seen. An object missed in a few samples keeps its cover meanwhile.
 */

export interface TimedBoxes {
  /** Time of the sampled frame, in seconds. */
  t: number;
  /** Covers in display pixels of the full-size frame (shape kept: faces are ellipses). */
  boxes: (Rect & { shape?: Cover['shape']; color?: Cover['color']; silhouette?: Silhouette })[];
}

type TBox = TimedBoxes['boxes'][number];

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
      // Same object if it kept a similar size and overlaps, or moved less than `maxDist` box sizes.
      if (sizeRatio < 1.8 && (iou(ra, rb) > 0.1 || dist < maxDist)) pairs.push({ i, j, score: iou(ra, rb) - dist });
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

/** One face, plate or person followed through the video: its boxes at the sampled times. */
export interface Track {
  points: { t: number; box: TBox }[];
}

/** Faces link only to faces; a person outlined in one sample and boxed in the next is still one person. */
function family(b: TBox): 'ellipse' | 'other' {
  return b.shape === 'ellipse' ? 'ellipse' : 'other';
}

/** Up to this many samples in a row may miss an object before its track ends. */
const MAX_GAP = 2;
/** Fixed margin (fraction of the box size on each side) for small changes between samples. */
const BASE_MARGIN = 0.1;
/**
 * Hand shake and walking bob that sampling cannot see move the whole picture by about the same number of
 * pixels, whatever the size of a face: this fraction of the frame's longer side is added on each side.
 */
const SHAKE = 0.006;
/** Margin for an object seen in one sample only (its motion is unknown). */
const LONE_MARGIN = 0.4;
/** Largest margin, so a cover stays a cover of its object rather than of half the frame. */
const MAX_MARGIN = 1.5;

/** Where a track's object is expected at time t, from its last two points (constant speed). */
function predict(tr: Track, t: number): TBox {
  const p = tr.points;
  const b = p[p.length - 1]!;
  const a = p[p.length - 2];
  if (!a || b.t - a.t <= 1e-6) return b.box;
  const f = (t - b.t) / (b.t - a.t);
  const ca = center(a.box);
  const cb = center(b.box);
  return { ...b.box, x: b.box.x + (cb.x - ca.x) * f, y: b.box.y + (cb.y - ca.y) * f };
}

/**
 * Links the detections of all samples into tracks (one per face, plate or person), so each object gets one
 * cover that moves with it, instead of a pile of covers from neighbouring samples. A track is matched where its
 * object is expected to be by now (so a fast but steady face stays one track), and only nearby: linking two
 * different people would move a cover away from both, while starting a new track only costs a second cover.
 */
export function buildTracks(samples: TimedBoxes[]): Track[] {
  const tracks: Track[] = [];
  const lastIndex: number[] = [];
  const open: number[] = [];
  samples.forEach((sample, k) => {
    // Tracks not seen for more than MAX_GAP samples are closed for good.
    for (let i = open.length - 1; i >= 0; i--) if (k - lastIndex[open[i]!]! > MAX_GAP + 1) open.splice(i, 1);
    const unmatched = new Set(sample.boxes.map((_, j) => j));
    // Prefer tracks seen most recently; only link covers of the same family (a face to a face).
    for (const gap of [1, 2, 3]) {
      for (const fam of ['ellipse', 'other'] as const) {
        const candidates = open.filter((i) => k - lastIndex[i]! === gap && family(tracks[i]!.points[0]!.box) === fam);
        if (!candidates.length) continue;
        // A track with a known speed is looked for close to where it should be; a track seen once (speed
        // unknown) a little further, but only over one sample, where a fast face can move a few of its widths.
        for (const known of [true, false]) {
          const group = candidates.filter((i) => (tracks[i]!.points.length > 1) === known);
          const fresh = [...unmatched].filter((j) => family(sample.boxes[j]!) === fam);
          if (!group.length || !fresh.length || (!known && gap > 1)) continue;
          const expected = group.map((i) => predict(tracks[i]!, sample.t));
          const freshBoxes = fresh.map((j) => sample.boxes[j]!);
          for (const [a, b] of matchBoxes(expected, freshBoxes, known ? 1 + 0.5 * gap : 3)) {
            const ti = group[expected.indexOf(a)]!;
            const bj = fresh[freshBoxes.indexOf(b)]!;
            tracks[ti]!.points.push({ t: sample.t, box: sample.boxes[bj]! });
            lastIndex[ti] = k;
            unmatched.delete(bj);
          }
        }
      }
    }
    for (const j of unmatched) {
      tracks.push({ points: [{ t: sample.t, box: sample.boxes[j]! }] });
      lastIndex.push(k);
      open.push(tracks.length - 1);
    }
  });
  return tracks;
}

interface Timeline {
  tracks: Track[];
  step: number;
  first: number;
  last: number;
}

const trackCache = new WeakMap<TimedBoxes[], Timeline>();

/** Typical time between samples: the median of the real gaps (repeated frames give gaps of 0 and are ignored). */
function typicalStep(samples: TimedBoxes[]): number {
  const gaps = samples
    .slice(1)
    .map((s, i) => s.t - samples[i]!.t)
    .filter((g) => g > 1e-3)
    .sort((a, b) => a - b);
  return gaps.length ? Math.max(1 / 30, gaps[Math.floor(gaps.length / 2)]!) : 1 / 3;
}

function timelineOf(samples: TimedBoxes[]): Timeline {
  let c = trackCache.get(samples);
  if (!c) {
    c = { tracks: buildTracks(samples), step: typicalStep(samples), first: samples[0]!.t, last: samples[samples.length - 1]!.t };
    trackCache.set(samples, c);
  }
  return c;
}

/** Centre displacement per second between two points (0 when they share a time). */
function velocity(a: { t: number; box: Rect }, b: { t: number; box: Rect }): { x: number; y: number } {
  const dt = b.t - a.t;
  if (dt <= 1e-6) return { x: 0, y: 0 };
  const ca = center(a.box);
  const cb = center(b.box);
  return { x: (cb.x - ca.x) / dt, y: (cb.y - ca.y) / dt };
}

/**
 * The covers to paint on the frame shown at time `t` (seconds), in display pixels of a w x h frame.
 * Each tracked object gets one cover, sized with the margins described at the top of this file.
 */
export function masksAt(samples: TimedBoxes[], t: number, w: number, h: number): Cover[] {
  if (!samples.length) return [];
  const { tracks, step, first, last } = timelineOf(samples);
  const hold = step * (MAX_GAP + 0.5);
  const out: Cover[] = [];
  for (const tr of tracks) {
    const p = tr.points;
    const n = p.length;
    const t0 = p[0]!.t;
    const t1 = p[n - 1]!.t;
    // Held for a while before it was first and after it was last seen; to the very edge of the video when it
    // was there in the first or last sample.
    if (t < t0 - (t0 <= first + 1e-6 ? Infinity : hold) || t > t1 + (t1 >= last - 1e-6 ? Infinity : hold)) continue;

    // The segment used: the two points around t, or the first/last two beyond the ends.
    let j = 0;
    while (j < n - 2 && p[j + 1]!.t < t) j++;
    const a = p[j]!;
    const b = p[Math.min(j + 1, n - 1)]!;
    const v = velocity(a, b);
    const dt = b.t - a.t;
    const f = dt > 1e-6 ? Math.min(1, Math.max(0, (t - a.t) / dt)) : 0;
    let box: Rect = lerp(a.box, b.box, f);
    const away = t < t0 ? t0 - t : t > t1 ? t - t1 : 0;
    if (away) {
      // Beyond the ends: keep moving the same way (for at most the hold time; then it stays put).
      const shift = (t < t0 ? -1 : 1) * Math.min(away, hold);
      const from = t < t0 ? p[0]!.box : p[n - 1]!.box;
      box = { ...from, x: from.x + v.x * shift, y: from.y + v.y * shift };
    }
    const size = Math.max(1, Math.min(box.w, box.h));
    let margin: number;
    if (n === 1) {
      margin = LONE_MARGIN;
    } else {
      // How much the motion changes around this segment (turning, stopping): the change of velocity between
      // neighbouring segments, as a distance over one sample step.
      const vPrev = j > 0 ? velocity(p[j - 1]!, a) : v;
      const vNext = j + 2 < n ? velocity(b, p[j + 2]!) : v;
      const span = Math.max(dt, step);
      const turn = Math.max(Math.hypot(v.x - vPrev.x, v.y - vPrev.y), Math.hypot(vNext.x - v.x, vNext.y - v.y)) * span;
      const speed = Math.hypot(v.x, v.y);
      // Frame times differ a little from sample times; the longer unseen, the less sure the position.
      margin = BASE_MARGIN + (SHAKE * Math.max(w, h) + 0.5 * turn + speed * 0.05 + speed * 0.5 * Math.min(away, hold)) / size;
      if (dt > step * 1.5) margin += 0.1; // interpolating across missed samples
      margin = Math.min(MAX_MARGIN, margin);
    }
    let grown = { x: box.x - box.w * margin, y: box.y - box.h * margin, w: box.w * (1 + 2 * margin), h: box.h * (1 + 2 * margin) };
    if (a.box.shape === 'ellipse') {
      // A face oval is drawn a little larger than its box (to reach the box's corners, see ellipseOf). Here the
      // margin already does that, so the oval is fitted to the grown box itself.
      const k = 1 / ELLIPSE_REACH;
      grown = { x: grown.x + (grown.w * (1 - k)) / 2, y: grown.y + (grown.h * (1 - k)) / 2, w: grown.w * k, h: grown.h * k };
    }
    // Ovals are not cut to the frame: cutting would shrink the oval and leave a face at the edge partly bare.
    let c: Cover = a.box.shape === 'ellipse' ? { ...grown, shape: 'ellipse' } : { ...clampTo(grown, w, h), shape: 'rounded' };
    // A person keeps their outline only while both neighbouring samples have one; otherwise the whole box.
    const sa = a.box.silhouette;
    const sb = b.box.silhouette;
    if (a.box.shape === 'silhouette' && b.box.shape === 'silhouette' && sa && sb && sa.w === sb.w && sa.h === sb.h) {
      const o = paddedOutline(sa, sb, margin);
      // Not clamped to the frame: the outline is laid over the whole grown box.
      const mx = o.pad / sa.w;
      const my = o.pad / sa.h;
      c = { x: box.x - box.w * mx, y: box.y - box.h * my, w: box.w * (1 + 2 * mx), h: box.h * (1 + 2 * my), shape: 'silhouette', silhouette: o.silhouette };
    }
    if (a.box.color) c.color = a.box.color;
    out.push(c);
  }
  return out.filter((r) => r.w > 0 && r.h > 0);
}

function clampTo(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(w, r.x + r.w);
  const y1 = Math.min(h, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/* ---------- Person outlines in videos ---------- */

/** Extra growth of a person's outline in videos, as a fraction of its box (on top of the motion margin). */
export const SILHOUETTE_GROW = 0.05;

/** Grows the marked cells by r in every direction (square neighbourhood, two separable passes). */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src;
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

/**
 * The outline to draw between two samples: the union of both outlines (each relative to its own box), placed
 * in a grid with `pad` extra cells on every side and grown by `grow` cells, so it covers the person wherever
 * they moved by up to that much. Growing (not stretching) keeps arms and legs at the box edge covered.
 */
export function blendSilhouettes(a: Silhouette, b: Silhouette, grow: number, pad = 0): Silhouette {
  if (a.w !== b.w || a.h !== b.h) throw new Error('silhouette sizes differ');
  const W = a.w + 2 * pad;
  const H = a.h + 2 * pad;
  const both = new Uint8Array(W * H);
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = y * a.w + x;
      if (a.data[i] || b.data[i]) both[(y + pad) * W + x + pad] = 1;
    }
  }
  return { w: W, h: H, data: dilate(both, W, H, grow) };
}

/** Recently used padded outlines (frames come in order, so a small cache serves almost every frame). */
const outlineCache = new Map<string, { silhouette: Silhouette; pad: number }>();
const OUTLINE_CACHE_SIZE = 48;
const outlineIds = new WeakMap<Silhouette, number>();
let nextOutlineId = 1;

function outlineId(s: Silhouette): number {
  let id = outlineIds.get(s);
  if (id === undefined) outlineIds.set(s, (id = nextOutlineId++));
  return id;
}

function paddedOutline(a: Silhouette, b: Silhouette, margin: number): { silhouette: Silhouette; pad: number } {
  // Pad by the motion margin, rounded up to steps of 4 cells so neighbouring frames share one outline.
  const pad = Math.ceil((margin * Math.max(a.w, a.h)) / 4) * 4;
  const key = `${outlineId(a)}:${outlineId(b)}:${pad}`;
  const hit = outlineCache.get(key);
  if (hit) {
    outlineCache.delete(key);
    outlineCache.set(key, hit);
    return hit;
  }
  const entry = { silhouette: blendSilhouettes(a, b, pad + Math.ceil(SILHOUETTE_GROW * Math.max(a.w, a.h)), pad), pad };
  outlineCache.set(key, entry);
  while (outlineCache.size > OUTLINE_CACHE_SIZE) outlineCache.delete(outlineCache.keys().next().value!);
  return entry;
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
