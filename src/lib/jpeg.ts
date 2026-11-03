import { FormatError, ascii, concat, startsWith, u16be } from './bytes';

/** One marker segment of a JPEG file. `start` points at the 0xFF of the marker. */
export interface JpegSegment {
  marker: number;
  start: number;
  /** Total bytes including marker, length field, payload and (for SOS) the entropy-coded data. */
  length: number;
  /** Payload without marker and length field. Empty for standalone markers. */
  payload: Uint8Array;
}

export interface JpegLayout {
  segments: JpegSegment[];
  /** Offset just after the EOI marker, or the file length when EOI is missing. */
  end: number;
  /** Bytes after EOI (for example a Motion Photo video or leftovers of an older image). */
  trailing: number;
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;

function isStandalone(marker: number): boolean {
  return marker === SOI || marker === EOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === SOI && b[2] === 0xff;
}

/** Splits a JPEG into segments. Throws FormatError on malformed input. */
export function parseJpeg(b: Uint8Array): JpegLayout {
  if (!isJpeg(b)) throw new FormatError('not a JPEG');
  const segments: JpegSegment[] = [{ marker: SOI, start: 0, length: 2, payload: new Uint8Array(0) }];
  let o = 2;
  while (o < b.length) {
    if (b[o] !== 0xff) throw new FormatError(`expected marker at ${o}`);
    // Fill bytes: any number of 0xFF may precede a marker.
    let m = o + 1;
    while (m < b.length && b[m] === 0xff) m++;
    if (m >= b.length) throw new FormatError('truncated marker');
    const marker = b[m]!;
    const start = o;
    if (isStandalone(marker)) {
      segments.push({ marker, start, length: m + 1 - start, payload: new Uint8Array(0) });
      o = m + 1;
      if (marker === EOI) return { segments, end: o, trailing: b.length - o };
      continue;
    }
    const len = u16be(b, m + 1);
    if (len < 2 || m + 1 + len > b.length) throw new FormatError('bad segment length');
    const payload = b.subarray(m + 3, m + 1 + len);
    let next = m + 1 + len;
    if (marker === SOS) {
      // Entropy-coded data runs until a marker that is not a stuffed byte (FF00) or a restart marker.
      while (next < b.length) {
        if (b[next] === 0xff && next + 1 < b.length) {
          const n = b[next + 1]!;
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        next++;
      }
    }
    segments.push({ marker, start, length: next - start, payload });
    o = next;
  }
  // No EOI: treat the whole file as image data.
  return { segments, end: b.length, trailing: 0 };
}

/** Markers that carry only the picture itself. Everything else (APPn, COM, ...) is metadata. */
export function isImageDataMarker(marker: number): boolean {
  if (marker === SOI || marker === EOI || marker === SOS) return true;
  if (marker === 0xdb /* DQT */ || marker === 0xc4 /* DHT */ || marker === 0xdd /* DRI */) return true;
  if (marker === 0xcc /* DAC */) return true;
  // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
  if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) return true;
  return false;
}

/** A minimal JFIF header (version 1.01, square pixels, no thumbnail) so every viewer reads the file the same way. */
export const MINIMAL_JFIF = new Uint8Array([
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);

/**
 * Rebuilds a JPEG keeping only the segments needed to show the picture, plus a fresh minimal JFIF header.
 * Drops every APPn segment (EXIF, XMP, ICC, IPTC, MPF, C2PA, maker data), comments and anything after EOI.
 */
export function stripJpeg(b: Uint8Array): Uint8Array {
  const { segments } = parseJpeg(b);
  const parts: Uint8Array[] = [new Uint8Array([0xff, SOI]), MINIMAL_JFIF];
  let sawEoi = false;
  for (const s of segments) {
    if (s.marker === SOI) continue;
    if (!isImageDataMarker(s.marker)) continue;
    if (s.marker === EOI) sawEoi = true;
    parts.push(b.subarray(s.start, s.start + s.length));
  }
  if (!sawEoi) parts.push(new Uint8Array([0xff, EOI]));
  return concat(parts);
}

/** Describes why a JPEG is not minimal, or returns an empty list when it only holds picture data. */
export function jpegProblems(b: Uint8Array): string[] {
  const problems: string[] = [];
  const { segments, trailing } = parseJpeg(b);
  for (const s of segments) {
    if (isImageDataMarker(s.marker)) continue;
    if (s.marker === 0xe0 && s.length === MINIMAL_JFIF.length && startsWith(b, MINIMAL_JFIF, s.start)) continue;
    problems.push(`segment 0x${s.marker.toString(16)}`);
  }
  if (trailing > 0) problems.push(`${trailing} bytes after end of image`);
  return problems;
}

/** Short identifier of an APP segment, like "Exif", "http://ns.adobe.com/xap/1.0/" or "ICC_PROFILE". */
export function appIdentifier(s: JpegSegment): string {
  const p = s.payload;
  let n = 0;
  while (n < p.length && n < 64 && p[n] !== 0) n++;
  return ascii(p, 0, n);
}
