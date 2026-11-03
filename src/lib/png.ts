import { FormatError, ascii, concat, startsWith, u32be } from './bytes';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngChunk {
  type: string;
  start: number;
  /** Total bytes: length field, type, data and CRC. */
  length: number;
  data: Uint8Array;
}

export interface PngLayout {
  chunks: PngChunk[];
  /** Bytes after IEND (for example leftovers of an uncropped screenshot, "aCropalypse"). */
  trailing: number;
}

export function isPng(b: Uint8Array): boolean {
  return startsWith(b, PNG_SIGNATURE);
}

export function parsePng(b: Uint8Array): PngLayout {
  if (!isPng(b)) throw new FormatError('not a PNG');
  const chunks: PngChunk[] = [];
  let o = 8;
  while (o < b.length) {
    const len = u32be(b, o);
    if (o + 12 + len > b.length) throw new FormatError('truncated PNG chunk');
    const type = ascii(b, o + 4, 4);
    chunks.push({ type, start: o, length: 12 + len, data: b.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === 'IEND') return { chunks, trailing: b.length - o };
  }
  throw new FormatError('PNG without IEND');
}

/** Chunks that hold only the picture. */
const IMAGE_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/** Rebuilds a PNG with only picture chunks; drops text, EXIF, XMP, ICC, time stamps and anything after IEND. */
export function stripPng(b: Uint8Array): Uint8Array {
  const { chunks } = parsePng(b);
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  for (const c of chunks) if (IMAGE_CHUNKS.has(c.type)) parts.push(b.subarray(c.start, c.start + c.length));
  return concat(parts);
}

export function pngProblems(b: Uint8Array): string[] {
  const { chunks, trailing } = parsePng(b);
  const problems = chunks.filter((c) => !IMAGE_CHUNKS.has(c.type)).map((c) => `chunk ${c.type}`);
  if (trailing > 0) problems.push(`${trailing} bytes after end of image`);
  return problems;
}
