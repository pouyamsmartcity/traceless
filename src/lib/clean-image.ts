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

/**
 * Draws the picture from its pixels onto a fresh canvas, paints solid masks, encodes a new file,
 * removes anything but picture data from it, and checks the result independently.
 * `masks` are in the decoded image's pixels.
 */
export async function renderClean(img: DecodedImage, masks: Rect[], type: OutputType): Promise<Uint8Array> {
  const { width, height, scale } = outputSize(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: type === 'image/png' });
  if (!ctx) throw new ImageCleanError('tooLarge', 'no drawing surface');
  if (type === 'image/jpeg') {
    // JPEG has no transparency: put a white background under transparent pixels.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.element, 0, 0, width, height);
  ctx.fillStyle = MASK_COLOR;
  for (const m of masks) {
    const x = Math.floor(m.x * scale);
    const y = Math.floor(m.y * scale);
    ctx.fillRect(x, y, Math.ceil((m.x + m.w) * scale) - x, Math.ceil((m.y + m.h) * scale) - y);
  }
  // A canvas that was too big for the device comes back empty; check one masked/unmasked pixel exists.
  const probe = ctx.getImageData(0, 0, 1, 1).data;
  if (probe.length !== 4) throw new ImageCleanError('tooLarge', 'drawing surface failed');

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
