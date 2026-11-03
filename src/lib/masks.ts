import type { Rect } from './detect/geometry';

/**
 * Drawing covers. Every cover is a single solid colour inside its shape, so nothing of what is under it can be
 * recovered; only the shape and the colour are chosen to look good:
 * - faces: an ellipse that fully contains the face,
 * - plates, text and hand-drawn covers: rounded rectangles,
 * - whole people: their silhouette, found by a segmentation network (a rounded box when that fails).
 * Styles: "smart" takes its colour from just around the cover so it sits naturally in the picture,
 * "black" is the classic look, "brand" is Traceless's green with its eraser mark, "sticker" is a friendly solid pastel
 * (faces get a drawn smiley on top of the solid fill).
 */

export type MaskShape = 'ellipse' | 'rounded' | 'rect' | 'silhouette';
export type MaskStyle = 'smart' | 'black' | 'brand' | 'sticker';
export const MASK_STYLES: readonly MaskStyle[] = ['smart', 'black', 'brand', 'sticker'];

/** A silhouette at low resolution, covering the cover's box (1 = cover, 0 = keep). */
export interface Silhouette {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface Cover extends Rect {
  shape: MaskShape;
  silhouette?: Silhouette;
  /** Colour for the smart style, when it was sampled earlier (videos sample it once per detection). */
  color?: [number, number, number];
}

const BRAND = '#126354';
/** Sticker style: faces are sunny yellow, everything else a soft pastel (all fully opaque). */
const STICKER_FACE = '#ffd34e';
const STICKER_OTHER = ['#9bd8c5', '#a9c8ff', '#f7b2c4', '#cdb8f0'];

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** How far a face oval reaches beyond its box (radius over half the box side). */
export const ELLIPSE_REACH = 1.12;

/** The face ellipse, sized so it contains the whole (already enlarged) face box's core. */
export function ellipseOf(r: Rect): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: (r.w / 2) * ELLIPSE_REACH, ry: (r.h / 2) * ELLIPSE_REACH };
}

/** Traces the cover's outline (for the editor). Silhouettes are traced as their box. */
export function traceCover(ctx: Ctx, c: Cover, s: number): void {
  path(ctx, c.shape === 'silhouette' ? { ...c, shape: 'rounded' } : c, s);
}

function path(ctx: Ctx, c: Cover, s: number): void {
  const x = c.x * s;
  const y = c.y * s;
  const w = c.w * s;
  const h = c.h * s;
  ctx.beginPath();
  if (c.shape === 'ellipse') {
    const e = ellipseOf({ x, y, w, h });
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
  } else if (c.shape === 'rect') {
    ctx.rect(x, y, w, h);
  } else {
    const r = Math.min(w, h) * 0.22;
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
}

/** Average colour of a thin ring just outside the cover's box, from the pixels of a w x h canvas. */
function ringColorFrom(d: Uint8ClampedArray, cw: number, ch: number, c: Rect, s: number): [number, number, number] {
  const pad = Math.max(2, Math.round(Math.min(c.w, c.h) * s * 0.08));
  const x0 = Math.max(0, Math.floor(c.x * s) - pad);
  const y0 = Math.max(0, Math.floor(c.y * s) - pad);
  const x1 = Math.min(cw, Math.ceil((c.x + c.w) * s) + pad);
  const y1 = Math.min(ch, Math.ceil((c.y + c.h) * s) + pad);
  if (x1 <= x0 || y1 <= y0) return [40, 40, 40];
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(1, Math.floor((x1 - x0 + y1 - y0) / 200));
  const add = (x: number, y: number) => {
    const i = (y * cw + x) * 4;
    r += d[i]!;
    g += d[i + 1]!;
    b += d[i + 2]!;
    n++;
  };
  for (let x = x0; x < x1; x += step) {
    for (let k = 0; k < pad && y0 + k < y1; k++) {
      add(x, y0 + k);
      add(x, y1 - 1 - k);
    }
  }
  for (let y = y0; y < y1; y += step) {
    for (let k = 0; k < pad && x0 + k < x1; k++) {
      add(x0 + k, y);
      add(x1 - 1 - k, y);
    }
  }
  if (!n) return [40, 40, 40];
  // Slightly darker and less saturated than the surroundings, so a cover reads as a cover.
  const avg = [r / n, g / n, b / n];
  const grey = (avg[0]! + avg[1]! + avg[2]!) / 3;
  return avg.map((v) => Math.round((v * 0.75 + grey * 0.25) * 0.82)) as [number, number, number];
}

/**
 * Smart-style colours for many covers with a single read of the canvas (reading pixels is slow on phones).
 * `scale` maps cover coordinates to canvas pixels.
 */
export function sampleColors(ctx: Ctx, covers: Rect[], scale: number, cw: number, ch: number): [number, number, number][] {
  if (!covers.length) return [];
  const d = ctx.getImageData(0, 0, cw, ch).data;
  return covers.map((c) => ringColorFrom(d, cw, ch, c, scale));
}

/** A smaller copy of an outline (`cells` per side); a cell is set if any part of it was (never uncovers). */
export function shrinkOutline(s: Silhouette, cells: number): Silhouette {
  if (s.w <= cells && s.h <= cells) return s;
  const w = Math.min(cells, s.w);
  const h = Math.min(cells, s.h);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < s.h; y++) {
    const yy = Math.min(h - 1, Math.floor((y * h) / s.h));
    for (let x = 0; x < s.w; x++) {
      if (s.data[y * s.w + x]) data[yy * w + Math.min(w - 1, Math.floor((x * w) / s.w))] = 1;
    }
  }
  return { w, h, data };
}

function silhouetteCanvas(c: Cover, s: number): OffscreenCanvas | HTMLCanvasElement | undefined {
  const m = c.silhouette;
  if (!m) return undefined;
  const w = Math.max(1, Math.round(c.w * s));
  const h = Math.max(1, Math.round(c.h * s));
  const small = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(m.w, m.h) : Object.assign(document.createElement('canvas'), { width: m.w, height: m.h });
  const sctx = small.getContext('2d') as Ctx | null;
  if (!sctx) return undefined;
  const img = sctx.createImageData(m.w, m.h);
  for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = m.data[i] ? 255 : 0;
  sctx.putImageData(img, 0, 0);
  const big = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const bctx = big.getContext('2d') as Ctx | null;
  if (!bctx) return undefined;
  // Scale up smoothly, soften the steps a little, then cut at half: a smooth, fully opaque outline.
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  const soften = Math.max(1, Math.round(Math.min(w, h) / m.w));
  if ('filter' in bctx) bctx.filter = `blur(${soften}px)`;
  bctx.drawImage(small, 0, 0, w, h);
  if ('filter' in bctx) bctx.filter = 'none';
  const px = bctx.getImageData(0, 0, w, h);
  for (let i = 3; i < px.data.length; i += 4) px.data[i] = px.data[i]! >= 100 ? 255 : 0;
  bctx.putImageData(px, 0, 0);
  return big;
}

function smiley(ctx: Ctx, c: Cover, s: number): void {
  const e = ellipseOf({ x: c.x * s, y: c.y * s, w: c.w * s, h: c.h * s });
  const r = Math.min(e.rx, e.ry);
  if (r < 8) return;
  ctx.save();
  ctx.fillStyle = '#3b2a12';
  ctx.strokeStyle = '#3b2a12';
  ctx.lineCap = 'round';
  // Eyes.
  for (const dx of [-0.33, 0.33]) {
    ctx.beginPath();
    ctx.ellipse(e.cx + dx * r, e.cy - 0.18 * r, 0.09 * r, 0.13 * r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Smile.
  ctx.lineWidth = Math.max(1.5, 0.08 * r);
  ctx.beginPath();
  ctx.arc(e.cx, e.cy + 0.02 * r, 0.42 * r, Math.PI * 0.18, Math.PI * 0.82);
  ctx.stroke();
  // Cheeks.
  ctx.fillStyle = 'rgba(255, 120, 90, 0.45)';
  for (const dx of [-0.52, 0.52]) {
    ctx.beginPath();
    ctx.ellipse(e.cx + dx * r, e.cy + 0.16 * r, 0.12 * r, 0.07 * r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function eraserMark(ctx: Ctx, c: Cover, s: number): void {
  const size = Math.min(c.w, c.h) * s * 0.42;
  if (size < 14) return;
  const cx = (c.x + c.w / 2) * s;
  const cy = (c.y + c.h / 2) * s;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 5);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  const w = size;
  const h = size * 0.48;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(-w / 2, -h / 2, w, h, h * 0.25);
  else ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fill();
  ctx.fillStyle = '#ffc400';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(-w / 2, -h / 2, w * 0.38, h, h * 0.25);
  else ctx.rect(-w / 2, -h / 2, w * 0.38, h);
  ctx.fill();
  ctx.restore();
}

/**
 * Paints covers onto a canvas that already holds the picture. `scale` maps cover coordinates to canvas pixels.
 * Colours for the "smart" style are all sampled first, from the untouched picture.
 */
export function paintCovers(ctx: Ctx, covers: Cover[], style: MaskStyle, scale: number, canvasW: number, canvasH: number): void {
  if (!covers.length) return;
  const missing = style === 'smart' ? covers.filter((c) => !c.color) : [];
  const sampled = sampleColors(ctx, missing, scale, canvasW, canvasH);
  const own = covers.map((c) => (style === 'smart' ? (c.color ?? sampled[missing.indexOf(c)]) : undefined));
  // Overlapping covers (a crowd, or one face held across video frames) share one colour, so they read
  // as a single clean patch: the colour of the largest cover in each group.
  const group = groupsOf(covers);
  const colourOf = (i: number) => {
    const g = group[i]!;
    let best = i;
    for (let j = 0; j < covers.length; j++) if (group[j] === g && covers[j]!.w * covers[j]!.h > covers[best]!.w * covers[best]!.h) best = j;
    return own[best];
  };
  const stickerOf = (i: number) => {
    // One colour per group; a group with a face is a face sticker.
    const g = group[i]!;
    if (covers.some((c, j) => group[j] === g && c.shape === 'ellipse')) return STICKER_FACE;
    return STICKER_OTHER[g % STICKER_OTHER.length]!;
  };
  const fills = covers.map((_, i) =>
    style === 'black' ? '#000000' : style === 'brand' ? BRAND : style === 'sticker' ? stickerOf(i) : `rgb(${colourOf(i)!.join(',')})`,
  );
  const shaped = covers.map((c) => (c.shape === 'silhouette' && !c.silhouette ? { ...c, shape: 'rounded' as const } : c));

  // Smart style: edges first, then all fills on top, so only the outer edge of a group stays visible.
  if (style === 'smart') {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    shaped.forEach((c) => {
      if (c.shape === 'silhouette') return;
      ctx.lineWidth = Math.max(1.5, Math.min(c.w, c.h) * scale * 0.03) * 2;
      path(ctx, c, scale);
      ctx.stroke();
    });
    ctx.restore();
  }
  shaped.forEach((c, i) => {
    ctx.save();
    const sil = c.shape === 'silhouette' ? silhouetteCanvas(c, scale) : undefined;
    if (sil) {
      // Colour the silhouette, then lay it over the picture.
      const sctx = sil.getContext('2d') as Ctx;
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = fills[i]!;
      sctx.fillRect(0, 0, sil.width, sil.height);
      ctx.drawImage(sil, Math.round(c.x * scale), Math.round(c.y * scale));
    } else {
      path(ctx, c, scale);
      ctx.fillStyle = fills[i]!;
      ctx.fill();
    }
    ctx.restore();
  });
  if (style === 'sticker') {
    // A smiley on every face oval, drawn over its solid fill (nothing of the picture shows through).
    shaped.forEach((c) => {
      if (c.shape === 'ellipse') smiley(ctx, c, scale);
    });
  }
  if (style === 'brand') {
    // One mark per group, on its largest cover.
    const marked = new Set<number>();
    shaped.forEach((c, i) => {
      const g = group[i]!;
      if (marked.has(g)) return;
      let best = i;
      for (let j = 0; j < shaped.length; j++) if (group[j] === g && shaped[j]!.w * shaped[j]!.h > shaped[best]!.w * shaped[best]!.h) best = j;
      marked.add(g);
      eraserMark(ctx, shaped[best]!, scale);
    });
  }
}

/** Groups covers whose boxes overlap (union-find); returns a group id per cover. */
export function groupsOf(covers: Rect[]): number[] {
  const parent = covers.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < covers.length; i++) {
    for (let j = i + 1; j < covers.length; j++) {
      const a = covers[i]!;
      const b = covers[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) parent[find(i)] = find(j);
    }
  }
  return covers.map((_, i) => find(i));
}

/** True when point (x, y) lies inside the cover's shape (used to tap covers in the editor). */
export function coverContains(c: Cover, x: number, y: number): boolean {
  if (x < c.x || y < c.y || x > c.x + c.w || y > c.y + c.h) {
    if (c.shape !== 'ellipse') return false;
  }
  if (c.shape === 'ellipse') {
    const e = ellipseOf(c);
    return ((x - e.cx) / e.rx) ** 2 + ((y - e.cy) / e.ry) ** 2 <= 1;
  }
  return true;
}
