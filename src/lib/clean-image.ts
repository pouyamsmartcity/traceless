import type { Rect } from './detect/geometry';
import { paintCovers, type Cover, type MaskStyle } from './masks';
import { inspectImage, sniffImage } from './inspect-image';
import { jpegProblems, stripJpeg } from './jpeg';
import { pngProblems, stripPng } from './png';

/**
 * Most phones' browsers refuse canvases above ~16.7 million pixels (iPhone Safari's limit).
 * Larger photos (for example 48 MP) are scaled down to stay safely below it.
 */
export const MAX_PIXELS = 16_000_000;

export class ImageCleanError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'tooLarge' | 'encode' | 'leftovers',
    message: string,
  ) {
    super(message);
    this.name = 'ImageCleanError';
  }
}

export interface DecodedImage {
  element: HTMLImageElement;
  /** Size as displayed (after the EXIF rotation is applied by the browser). */
  width: number;
  height: number;
  url: string;
}

/** Decodes an image file. The browser applies the EXIF orientation, so width/height are as displayed. */
export async function decodeImage(file: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageCleanError('unsupported', 'this browser cannot open this image format');
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new ImageCleanError('unsupported', 'empty image');
  }
  return { element: img, width: img.naturalWidth, height: img.naturalHeight, url };
}

/** Longest side of a photo made "light" (for slow or expensive internet). */
export const LIGHT_MAX_SIDE = 1600;

export function outputSize(w: number, h: number, maxSide = Infinity): { width: number; height: number; scale: number } {
  const scale = Math.min(w * h > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (w * h)) : 1, maxSide / Math.max(w, h), 1);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), scale };
}

export type OutputType = 'image/jpeg' | 'image/png';

/** Screenshots and graphics stay PNG (sharp text); photos become JPEG. */
export function chooseOutputType(original: Uint8Array): OutputType {
  const kind = sniffImage(original);
  return kind === 'png' || kind === 'gif' || kind === 'bmp' ? 'image/png' : 'image/jpeg';
}

export const MASK_COLOR = '#000000';

function canvasToBlob(canvas: HTMLCanvasElement, type: OutputType, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageCleanError('encode', 'the browser could not create the picture'))), type, quality);
  });
}

/** Longest side of a photo made with extra protection. */
export const EXTRA_MAX_SIDE = 1600;

export interface ExtraTransform {
  outW: number;
  outH: number;
  /** Rotation in radians. */
  angle: number;
  /** Scale applied to the source picture (after rotation) so it covers the whole output. */
  scale: number;
}

/**
 * Plans the "extra protection" redraw: scale down, rotate very slightly and trim the edges a little.
 * The camera sensor's faint noise pattern (which can link photos to one camera) is matched pixel by
 * pixel, so shrinking, turning and cropping by unknown amounts makes matching much harder. Not impossible.
 * `rand` returns numbers in [0, 1).
 */
export function planExtraTransform(w: number, h: number, rand: () => number): ExtraTransform {
  const s0 = Math.min(1, EXTRA_MAX_SIDE / Math.max(w, h));
  const crop = 0.02 + 0.02 * rand();
  const outW = Math.max(1, Math.round(w * s0 * (1 - crop)));
  const outH = Math.max(1, Math.round(h * s0 * (1 - crop)));
  const degrees = (0.5 + rand()) * (rand() < 0.5 ? -1 : 1);
  const angle = (degrees * Math.PI) / 180;
  const c = Math.abs(Math.cos(angle));
  const sn = Math.abs(Math.sin(angle));
  // The rotated picture must cover the output rectangle completely (no empty corners).
  const scale = Math.max((outW * c + outH * sn) / w, (outW * sn + outH * c) / h) * 1.001;
  return { outW, outH, angle, scale };
}

function cryptoRand(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! / 2 ** 32;
}

/** Adds faint random grain (+/-2 levels) so the original fine noise is not carried over unchanged. */
function addGrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const noise = new Uint8Array(65536);
  for (let o = 0; o < d.length; o += noise.length) {
    crypto.getRandomValues(noise);
    const n = Math.min(noise.length, d.length - o);
    for (let i = 0; i < n; i++) {
      if ((o + i) % 4 === 3) continue; // leave transparency alone
      d[o + i] = d[o + i]! + ((noise[i]! % 5) - 2); // Uint8ClampedArray clamps to 0..255
    }
  }
  ctx.putImageData(img, 0, 0);
}

export interface RenderOptions {
  /** Weaken the camera sensor pattern (smaller, slightly turned and trimmed picture, fresh grain). */
  extra?: boolean;
  /** How covers look (all styles are solid; see masks.ts). */
  style?: MaskStyle;
  /** A smaller file for slow or expensive internet (at most LIGHT_MAX_SIDE pixels, lighter JPEG). */
  light?: boolean;
  /** Keep only this part of the picture (pixels of the upright picture). */
  crop?: Rect;
}

/** The crop limited to the picture (at least 8 x 8 pixels); undefined when it keeps everything. */
export function cropArea(crop: Rect | undefined, w: number, h: number): Rect | undefined {
  if (!crop) return undefined;
  const x = Math.max(0, Math.min(w - 8, Math.round(crop.x)));
  const y = Math.max(0, Math.min(h - 8, Math.round(crop.y)));
  const r = { x, y, w: Math.max(8, Math.min(w - x, Math.round(crop.w))), h: Math.max(8, Math.min(h - y, Math.round(crop.h))) };
  return r.x === 0 && r.y === 0 && r.w === w && r.h === h ? undefined : r;
}

/**
 * Draws the picture from its pixels onto a fresh canvas, paints solid masks, encodes a new file,
 * removes anything but picture data from it, and checks the result independently.
 * `masks` are in the decoded image's pixels.
 */
export async function renderClean(img: DecodedImage, masks: Cover[], type: OutputType, opts: RenderOptions = {}): Promise<Uint8Array> {
  // Cropping: only the chosen part is drawn; covers are moved with it.
  const area = cropArea(opts.crop, img.width, img.height) ?? { x: 0, y: 0, w: img.width, h: img.height };
  const { width, height, scale } = outputSize(area.w, area.h, opts.light ? LIGHT_MAX_SIDE : Infinity);
  let canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let ctx = canvas.getContext('2d', { alpha: type === 'image/png' });
  if (!ctx) throw new ImageCleanError('tooLarge', 'no drawing surface');
  if (type === 'image/jpeg') {
    // JPEG has no transparency: put a white background under transparent pixels.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.element, area.x, area.y, area.w, area.h, 0, 0, width, height);
  // Masks are painted before any further transformation, so they move with the picture.
  const placed = area.x || area.y ? masks.map((c) => ({ ...c, x: c.x - area.x, y: c.y - area.y })) : masks;
  paintCovers(ctx, placed, opts.style ?? 'smart', scale, width, height);
  // A canvas the device could not allocate silently ends up with no size.
  if (canvas.width !== width || canvas.height !== height) throw new ImageCleanError('tooLarge', 'drawing surface failed');

  if (opts.extra) {
    const plan = planExtraTransform(width, height, cryptoRand);
    const out = document.createElement('canvas');
    out.width = plan.outW;
    out.height = plan.outH;
    const octx = out.getContext('2d', { alpha: type === 'image/png' });
    if (!octx) throw new ImageCleanError('tooLarge', 'no drawing surface');
    if (type === 'image/jpeg') {
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, plan.outW, plan.outH);
    }
    octx.imageSmoothingQuality = 'high';
    octx.translate(plan.outW / 2, plan.outH / 2);
    octx.rotate(plan.angle);
    octx.scale(plan.scale, plan.scale);
    octx.drawImage(canvas, -width / 2, -height / 2);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    addGrain(octx, plan.outW, plan.outH);
    canvas.width = 0;
    canvas.height = 0;
    canvas = out;
    ctx = octx;
  }

  const encoded = new Uint8Array(await (await canvasToBlob(canvas, type, opts.light ? 0.8 : 0.92)).arrayBuffer());
  canvas.width = 0; // free memory early on phones
  canvas.height = 0;
  const bytes = type === 'image/jpeg' ? stripJpeg(encoded) : stripPng(encoded);
  const problems = await imageLeftovers(bytes, type);
  if (problems.length) throw new ImageCleanError('leftovers', problems.join('; '));
  return bytes;
}

/** Independent check of a cleaned image. Returns what is still revealing, or an empty list. */
export async function imageLeftovers(bytes: Uint8Array, type: OutputType): Promise<string[]> {
  const kind = sniffImage(bytes);
  const expected = type === 'image/jpeg' ? 'jpeg' : 'png';
  if (kind !== expected) return [`unexpected format ${kind}`];
  const structural = kind === 'jpeg' ? jpegProblems(bytes) : pngProblems(bytes);
  const inspection = await inspectImage(bytes);
  return [
    ...structural,
    ...inspection.findings.map((f) => f.id),
    ...(inspection.partial ? ['unreadable output'] : []),
  ];
}

/** Applies an EXIF orientation (1-8) around the centre of the current canvas origin. */
function orient(ctx: CanvasRenderingContext2D, o: number): void {
  if (o === 2) ctx.scale(-1, 1);
  else if (o === 3) ctx.rotate(Math.PI);
  else if (o === 4) ctx.scale(1, -1);
  else if (o === 5) {
    ctx.rotate(Math.PI / 2);
    ctx.scale(1, -1);
  } else if (o === 6) ctx.rotate(Math.PI / 2);
  else if (o === 7) {
    ctx.rotate(Math.PI / 2);
    ctx.scale(-1, 1);
  } else if (o === 8) ctx.rotate(-Math.PI / 2);
}

/**
 * Compares the hidden thumbnail with the picture itself (both shrunk to 32 x 32 grey). A large difference
 * means the picture was changed after the thumbnail was made (cropped, edited, or a different photo).
 * Cameras make thumbnails of other shapes in two ways (black bars, or a centre crop), so both are tried and
 * the smaller difference counts. Returns the mean difference (0..1), or undefined when it cannot be measured.
 */
export async function thumbnailDifference(thumbnail: Uint8Array, img: DecodedImage, orientation = 1): Promise<number | undefined> {
  const url = URL.createObjectURL(new Blob([thumbnail as BlobPart], { type: 'image/jpeg' }));
  try {
    const t = new Image();
    t.src = url;
    await t.decode();
    const grey = (draw: (ctx: CanvasRenderingContext2D) => void) => {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 32, 32);
      draw(ctx);
      const d = ctx.getImageData(0, 0, 32, 32).data;
      const g = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) g[i] = (0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!) / 255;
      return g;
    };
    // The thumbnail is stored unturned; turn it the way the browser turned the picture.
    const turned = orientation >= 5;
    const thumbAspect = turned ? t.naturalHeight / t.naturalWidth : t.naturalWidth / t.naturalHeight;
    const mainAspect = img.width / img.height;
    const thumb = grey((ctx) => {
      ctx.translate(16, 16);
      orient(ctx, orientation);
      ctx.drawImage(t, -16, -16, 32, 32);
    });
    const diff = (main: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < 1024; i++) sum += Math.abs(main[i]! - thumb[i]!);
      return sum / 1024;
    };
    // The picture fitted into the thumbnail's shape with bars ("contain"), and centre-cropped ("cover").
    const fit = (cover: boolean) =>
      grey((ctx) => {
        const r = mainAspect / thumbAspect;
        const w = cover ? Math.max(32, 32 * r) : Math.min(32, 32 * r);
        const h = cover ? Math.max(32, 32 / r) : Math.min(32, 32 / r);
        ctx.drawImage(img.element, (32 - w) / 2, (32 - h) / 2, w, h);
      });
    return Math.min(diff(fit(false)), diff(fit(true)));
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}
