/**
 * A minimal ZIP writer: files are stored as they are (photos and videos are already compressed), with a fixed
 * date (1 January 1980) so the archive does not tell when it was made. No comments, no extra fields.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** Largest archive this writer makes (no ZIP64). */
export const MAX_ZIP_BYTES = 0xfffffff0;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** DOS date for 1980-01-01 00:00. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export function makeZip(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const used = new Set<string>();
  for (const e of entries) {
    // Names stay unique and plain (no folders).
    let name = e.name.replace(/[\\/]/g, '_') || 'file';
    for (let k = 2; used.has(name); k++) name = e.name.replace(/(\.[^.]*)?$/, `-${k}$1`);
    used.add(name);
    const nameBytes = enc.encode(name);
    const crc = crc32(e.data);
    const size = e.data.length;
    if (offset + 30 + nameBytes.length + size > MAX_ZIP_BYTES) throw new RangeError('archive too large');
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, e.data as BlobPart);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + size;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  if (offset + cdSize + 22 > MAX_ZIP_BYTES || entries.length > 0xffff) throw new RangeError('archive too large');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end], { type: 'application/zip' });
}
