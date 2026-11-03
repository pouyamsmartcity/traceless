/** Small helpers for reading binary data. All multi-byte reads are bounds-checked. */

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/** Random access to a file's bytes, without loading the whole file. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function sourceFromBytes(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  };
}

export function sourceFromBlob(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + length)).arrayBuffer()),
  };
}

export function u16be(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) throw new FormatError('read past end');
  return (b[o]! << 8) | b[o + 1]!;
}

export function u32be(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw new FormatError('read past end');
  return ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
}

export function u32le(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw new FormatError('read past end');
  return ((b[o + 3]! << 24) >>> 0) + ((b[o + 2]! << 16) | (b[o + 1]! << 8) | b[o]!);
}

/** Reads a 64-bit big-endian unsigned integer. Values above 2^53 are rejected. */
export function u64be(b: Uint8Array, o: number): number {
  const hi = u32be(b, o);
  const lo = u32be(b, o + 4);
  if (hi >= 0x200000) throw new FormatError('64-bit size too large');
  return hi * 0x100000000 + lo;
}

export function ascii(b: Uint8Array, o: number, n: number): string {
  if (o + n > b.length) throw new FormatError('read past end');
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]!);
  return s;
}

export function utf8(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(b);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function startsWith(b: Uint8Array, prefix: ArrayLike<number>, at = 0): boolean {
  if (at + prefix.length > b.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[at + i] !== prefix[i]) return false;
  return true;
}

/** Index of `needle` (ASCII) in `b`, or -1. */
export function indexOfAscii(b: Uint8Array, needle: string, from = 0): number {
  const n = needle.length;
  if (n === 0) return from;
  const first = needle.charCodeAt(0);
  outer: for (let i = from; i <= b.length - n; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < n; j++) if (b[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
