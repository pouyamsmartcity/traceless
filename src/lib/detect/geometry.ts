/** Axis-aligned box in image pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection extends Rect {
  score: number;
  kind: 'face' | 'plate' | 'text' | 'person';
  /** People in photos: their outline inside the box (1 = person), when the segmentation network found it. */
  silhouette?: { w: number; h: number; data: Uint8Array };
}

export function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Share of `a`'s area that lies inside `b`. */
export function coverage(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return a.w * a.h > 0 ? (ix * iy) / (a.w * a.h) : 0;
}

/**
 * Non-maximum suppression. Also drops a box that lies mostly inside a stronger box, which happens when
 * tiles see the same face at different scales.
 */
export function nms<T extends Rect & { score: number }>(boxes: T[], iouThreshold: number): T[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: T[] = [];
  for (const b of sorted) {
    if (keep.every((k) => iou(b, k) <= iouThreshold && coverage(b, k) < 0.8)) keep.push(b);
  }
  return keep;
}

/** Square tiles of side `tile` that cover a `w`x`h` image with the given overlap. */
export function tiles(w: number, h: number, tile: number, overlap = 0.25): Rect[] {
  if (w <= tile && h <= tile) return [{ x: 0, y: 0, w, h }];
  const step = Math.max(1, Math.floor(tile * (1 - overlap)));
  const xs = positions(w, tile, step);
  const ys = positions(h, tile, step);
  const out: Rect[] = [];
  for (const y of ys) for (const x of xs) out.push({ x, y, w: Math.min(tile, w), h: Math.min(tile, h) });
  return out;
}

function positions(len: number, tile: number, step: number): number[] {
  if (len <= tile) return [0];
  // Evenly spaced tiles, the last one flush with the edge, with at least the requested overlap.
  const n = Math.ceil((len - tile) / step) + 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round((i * (len - tile)) / (n - 1)));
  return out;
}

/** Grows a box by the given fractions of its size on each side and clamps it to the image (unless `clamp` is false). */
export function expand(r: Rect, fx: number, fy: number, imgW: number, imgH: number, clamp = true): Rect {
  const x0 = Math.max(clamp ? 0 : -Infinity, r.x - r.w * fx);
  const y0 = Math.max(clamp ? 0 : -Infinity, r.y - r.h * fy);
  const x1 = Math.min(imgW, r.x + r.w * (1 + fx));
  const y1 = Math.min(imgH, r.y + r.h * (1 + fy));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** How a region of the image was scaled and padded into the square model input. */
export interface Letterbox {
  /** Model input side, e.g. 640. */
  size: number;
  /** Scale from region pixels to model pixels. */
  scale: number;
  padX: number;
  padY: number;
  /** Region of the source image that was fed in. */
  region: Rect;
}

export function letterbox(region: Rect, size: number): Letterbox {
  const scale = Math.min(size / region.w, size / region.h);
  const nw = Math.round(region.w * scale);
  const nh = Math.round(region.h * scale);
  return { size, scale, padX: Math.floor((size - nw) / 2), padY: Math.floor((size - nh) / 2), region };
}

/** Maps a box from model input coordinates back to source image coordinates. */
export function unletterbox(b: { x1: number; y1: number; x2: number; y2: number }, lb: Letterbox): Rect {
  const x1 = (b.x1 - lb.padX) / lb.scale + lb.region.x;
  const y1 = (b.y1 - lb.padY) / lb.scale + lb.region.y;
  const x2 = (b.x2 - lb.padX) / lb.scale + lb.region.x;
  const y2 = (b.y2 - lb.padY) / lb.scale + lb.region.y;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
