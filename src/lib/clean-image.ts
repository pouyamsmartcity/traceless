import type { Rect } from './detect/geometry';
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

export function outputSize(w: number, h: number): { width: number; height: number; scale: number } {
  const scale = w * h > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (w * h)) : 1;
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), scale };
}

export type OutputType = 'image/jpeg' | 'image/png';

/** Screenshots and graphics stay PNG (sharp text); photos become JPEG. */
export function chooseOutputType(original: Uint8Array): OutputType {
  const kind = sniffImage(original);
  return kind === 'png' || kind === 'gif' || kind === 'bmp' ? 'image/png' : 'image/jpeg';
}

export const MASK_COLOR = '#000000';

function canvasToBlob(canvas: HTMLCanvasElement, type: OutputType): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageCleanError('encode', 'the browser could not create the picture'))), type, 0.92);
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
}

/**
 * Draws the picture from its pixels onto a fresh canvas, paints solid masks, encodes a new file,
 * removes anything but picture data from it, and checks the result independently.
 * `masks` are in the decoded image's pixels.
 */
export async function renderClean(img: DecodedImage, masks: Rect[], type: OutputType, opts: RenderOptions = {}): Promise<Uint8Array> {
  const { width, height, scale } = outputSize(img.width, img.height);
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
  ctx.drawImage(img.element, 0, 0, width, height);
  // Masks are painted before any further transformation, so they move with the picture.
  ctx.fillStyle = MASK_COLOR;
  for (const m of masks) {
    const x = Math.floor(m.x * scale);
    const y = Math.floor(m.y * scale);
    ctx.fillRect(x, y, Math.ceil((m.x + m.w) * scale) - x, Math.ceil((m.y + m.h) * scale) - y);
  }
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

  const encoded = new Uint8Array(await (await canvasToBlob(canvas, type)).arrayBuffer());
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

/**
 * Compares the hidden thumbnail with the picture itself (both shrunk to 32 x 32 grey). A large difference
 * means the picture was changed after the thumbnail was made (cropped, edited, or a different photo).
 * Returns the mean difference (0..1), or undefined when it cannot be measured.
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
      draw(ctx);
      const d = ctx.getImageData(0, 0, 32, 32).data;
      const g = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) g[i] = (0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!) / 255;
      return g;
    };
    const main = grey((ctx) => ctx.drawImage(img.element, 0, 0, 32, 32));
    // The thumbnail is stored unrotated; turn it the way the browser turned the picture.
    const thumb = grey((ctx) => {
      ctx.translate(16, 16);
      if (orientation === 3) ctx.rotate(Math.PI);
      else if (orientation === 6) ctx.rotate(Math.PI / 2);
      else if (orientation === 8) ctx.rotate(-Math.PI / 2);
      ctx.drawImage(t, -16, -16, 32, 32);
    });
    let sum = 0;
    for (let i = 0; i < 1024; i++) sum += Math.abs(main[i]! - thumb[i]!);
    return sum / 1024;
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}
