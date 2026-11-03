import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { imageLeftovers, type OutputType } from '../lib/clean-image';
import type { Rect } from '../lib/detect/geometry';
import { headerSize, sniffImage } from '../lib/inspect-image';
import { stripJpeg } from '../lib/jpeg';
import { stripPng } from '../lib/png';

/**
 * Photos outside the browser (command line and agent tools): the same idea as the app. The picture is decoded to
 * plain pixels, turned upright, covered where asked, and written into a brand-new file that is checked again.
 * Nothing of the original file is copied. JPEG and PNG only (pure JavaScript, no native code).
 */

/** Largest picture handled here (pixels). */
export const NODE_MAX_PIXELS = 50_000_000;

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

export interface NodeCover extends Rect {
  shape?: 'rect' | 'ellipse';
}

export class NodeImageError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'tooLarge' | 'leftovers',
    message: string,
  ) {
    super(message);
    this.name = 'NodeImageError';
  }
}

export function decodePixels(bytes: Uint8Array): { pixels: Pixels; type: OutputType } {
  const kind = sniffImage(bytes);
  // The size is read from the header first: a small file that decodes to a huge picture is refused unread.
  const size = headerSize(bytes);
  if ((kind === 'jpeg' || kind === 'png') && (!size || size.width * size.height > NODE_MAX_PIXELS)) {
    throw new NodeImageError(size ? 'tooLarge' : 'unsupported', size ? `picture of ${size.width} x ${size.height} pixels is too large` : 'the picture is damaged or incomplete (its size cannot be read)');
  }
  try {
    return decodeKnown(bytes, kind);
  } catch (e) {
    if (e instanceof NodeImageError) throw e;
    // jpeg-js and pngjs report damage in their own words ("unexpected marker: ffff").
    throw new NodeImageError('unsupported', `the picture is damaged or incomplete (${e instanceof Error ? e.message : String(e)})`);
  }
}

function decodeKnown(bytes: Uint8Array, kind: ReturnType<typeof sniffImage>): { pixels: Pixels; type: OutputType } {
  if (kind === 'jpeg') {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: NODE_MAX_PIXELS / 1e6, maxMemoryUsageInMB: 2048 });
    return { pixels: { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length) }, type: 'image/jpeg' };
  }
  if (kind === 'png') {
    // Only the picture chunks are decoded: text, EXIF and anything after the end (an uncropped screenshot's
    // leftovers, "aCropalypse") never reach the decoder.
    const png = PNG.sync.read(Buffer.from(stripPng(bytes)));
    return { pixels: { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) }, type: 'image/png' };
  }
  throw new NodeImageError('unsupported', `${kind} pictures are only supported in the Traceless app (browser)`);
}


/** Turns the pixels upright according to the EXIF orientation (1-8), as browsers do when showing a photo. */
export function orient(p: Pixels, orientation = 1): Pixels {
  if (orientation < 2 || orientation > 8) return p;
  const swap = orientation >= 5;
  const W = swap ? p.height : p.width;
  const H = swap ? p.width : p.height;
  const out = new Uint8Array(W * H * 4);
  const src = new Uint32Array(p.data.buffer, p.data.byteOffset, p.width * p.height);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Source pixel for output pixel (x, y).
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: sx = p.width - 1 - x; sy = y; break;
        case 3: sx = p.width - 1 - x; sy = p.height - 1 - y; break;
        case 4: sx = x; sy = p.height - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = p.height - 1 - x; break;
        case 7: sx = p.width - 1 - y; sy = p.height - 1 - x; break;
        default: sx = p.width - 1 - y; sy = x; break; // 8
      }
      dst[y * W + x] = src[sy * p.width + sx]!;
    }
  }
  return { width: W, height: H, data: out };
}

/** Paints solid covers (opaque colour, nothing of the picture left under them). Coordinates are of the upright picture. */
export function paintSolid(p: Pixels, covers: NodeCover[], rgb: [number, number, number] = [0, 0, 0]): void {
  for (const c of covers) {
    const x0 = Math.max(0, Math.floor(c.x));
    const y0 = Math.max(0, Math.floor(c.y));
    const x1 = Math.min(p.width, Math.ceil(c.x + c.w));
    const y1 = Math.min(p.height, Math.ceil(c.y + c.h));
    // Ovals reach a little beyond the box (like the app), so a face box's corners are covered too.
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const rx = (c.w / 2) * 1.12;
    const ry = (c.h / 2) * 1.12;
    const ex0 = c.shape === 'ellipse' ? Math.max(0, Math.floor(cx - rx)) : x0;
    const ex1 = c.shape === 'ellipse' ? Math.min(p.width, Math.ceil(cx + rx)) : x1;
    const ey0 = c.shape === 'ellipse' ? Math.max(0, Math.floor(cy - ry)) : y0;
    const ey1 = c.shape === 'ellipse' ? Math.min(p.height, Math.ceil(cy + ry)) : y1;
    for (let y = ey0; y < ey1; y++) {
      for (let x = ex0; x < ex1; x++) {
        if (c.shape === 'ellipse' && ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 > 1) continue;
        const i = (y * p.width + x) * 4;
        p.data[i] = rgb[0];
        p.data[i + 1] = rgb[1];
        p.data[i + 2] = rgb[2];
        p.data[i + 3] = 255;
      }
    }
  }
}

/** Writes the pixels into a new file of the given type, strips our own encoder's headers and checks the result. */
export async function encodeClean(p: Pixels, type: OutputType, quality = 92): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (type === 'image/jpeg') {
    // JPEG has no transparency: transparent pixels become white.
    const data = new Uint8Array(p.data);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]! / 255;
      if (a < 1) for (let k = 0; k < 3; k++) data[i + k] = Math.round(data[i + k]! * a + 255 * (1 - a));
      data[i + 3] = 255;
    }
    const out = jpeg.encode({ width: p.width, height: p.height, data }, quality);
    bytes = stripJpeg(new Uint8Array(out.data));
  } else {
    const png = new PNG({ width: p.width, height: p.height });
    Buffer.from(p.data.buffer, p.data.byteOffset, p.data.length).copy(png.data);
    bytes = stripPng(new Uint8Array(PNG.sync.write(png)));
  }
  const problems = await imageLeftovers(bytes, type);
  if (problems.length) throw new NodeImageError('leftovers', problems.join('; '));
  return bytes;
}
