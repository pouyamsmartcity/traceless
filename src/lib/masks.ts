import type { Rect } from './detect/geometry';

/**
 * Drawing covers. Every cover is a single solid colour inside its shape, so nothing of what is under it can be
 * recovered; only the shape and the colour are chosen to look good:
 * - faces: an ellipse that fully contains the face,
 * - plates, text and hand-drawn covers: rounded rectangles,
 * - whole people: their silhouette, found by a segmentation network (a rounded box when that fails).
 * Styles: "smart" takes its colour from just around the cover so it sits naturally in the picture,
 * "black" is the classic look, "brand" is Pakkon's green with its eraser mark.
 */

export type MaskShape = 'ellipse' | 'rounded' | 'rect' | 'silhouette';
export type MaskStyle = 'smart' | 'black' | 'brand';

/** A silhouette at low resolution, covering the cover's box (1 = cover, 0 = keep). */
export interface Silhouette {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface Cover extends Rect {
  shape: MaskShape;
  silhouette?: Silhouette;
}

const BRAND = '#126354';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The face ellipse, sized so it contains the whole (already enlarged) face box's core. */
export function ellipseOf(r: Rect): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: (r.w / 2) * 1.12, ry: (r.h / 2) * 1.12 };
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

/** Average colour of a thin ring just outside the cover's box (in canvas pixels). */
function ringColor(ctx: Ctx, c: Cover, s: number, cw: number, ch: number): [number, number, number] {
  const pad = Math.max(2, Math.round(Math.min(c.w, c.h) * s * 0.08));
  const x0 = Math.max(0, Math.floor(c.x * s) - pad);
  const y0 = Math.max(0, Math.floor(c.y * s) - pad);
  const x1 = Math.min(cw, Math.ceil((c.x + c.w) * s) + pad);
  const y1 = Math.min(ch, Math.ceil((c.y + c.h) * s) + pad);
  if (x1 <= x0 || y1 <= y0) return [40, 40, 40];
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const w = x1 - x0;
  const h = y1 - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(1, Math.floor((w + h) / 200));
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    r += d[i]!;
    g += d[i + 1]!;
    b += d[i + 2]!;
    n++;
  };
  for (let x = 0; x < w; x += step) {
    for (let k = 0; k < pad && k < h; k++) {
      add(x, k);
      add(x, h - 1 - k);
    }
  }
  for (let y = 0; y < h; y += step) {
    for (let k = 0; k < pad && k < w; k++) {
      add(k, y);
      add(w - 1 - k, y);
    }
  }
  if (!n) return [40, 40, 40];
  // Slightly darker and less saturated than the surroundings, so a cover reads as a cover.
  const avg = [r / n, g / n, b / n];
  const grey = (avg[0]! + avg[1]! + avg[2]!) / 3;
  return avg.map((v) => Math.round((v * 0.75 + grey * 0.25) * 0.82)) as [number, number, number];
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
  const colours = covers.map((c) => (style === 'smart' ? ringColor(ctx, c, scale, canvasW, canvasH) : undefined));
  covers.forEach((c, i) => {
    const fill = style === 'black' ? '#000000' : style === 'brand' ? BRAND : `rgb(${colours[i]!.join(',')})`;
    const sil = c.shape === 'silhouette' ? silhouetteCanvas(c, scale) : undefined;
    ctx.save();
    if (sil) {
      // Colour the silhouette, then lay it over the picture.
      const sctx = sil.getContext('2d') as Ctx;
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = fill;
      sctx.fillRect(0, 0, sil.width, sil.height);
      ctx.drawImage(sil, Math.round(c.x * scale), Math.round(c.y * scale));
    } else {
      path(ctx, c.shape === 'silhouette' ? { ...c, shape: 'rounded' } : c, scale);
      ctx.fillStyle = fill;
      ctx.fill();
      if (style === 'smart') {
        // A thin, slightly darker edge so the cover is clearly a cover.
        ctx.lineWidth = Math.max(1.5, Math.min(c.w, c.h) * scale * 0.03);
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.stroke();
      }
    }
    if (style === 'brand') eraserMark(ctx, c, scale);
    ctx.restore();
  });
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
