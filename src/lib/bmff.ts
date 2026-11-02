import { FormatError, ascii, u32be, u64be, utf8, type ByteSource } from './bytes';
import { FindingList, parseIso6709, type Finding } from './findings';

/**
 * Minimal ISO base media file (MP4 / MOV / 3GP) reader: enough to find what a video reveals and to
 * double-check a cleaned file. It never loads the media data (mdat) into memory.
 */

export interface Box {
  type: string;
  /** Offset of the box header in its buffer. */
  start: number;
  headerSize: number;
  size: number;
}

/** Boxes whose payload is a list of child boxes. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'ilst', 'mvex', 'moof', 'traf', 'tref', 'meta']);

export function readBoxes(b: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64be(b, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerSize || o + size > end) throw new FormatError(`bad box ${JSON.stringify(type)}`);
    boxes.push({ type, start: o, headerSize, size });
    o += size;
  }
  return boxes;
}

/**
 * 'meta' is a FullBox in ISO files (4 extra bytes) but a plain container in QuickTime files.
 * Returns the offset where its children start.
 */
function metaChildrenStart(b: Uint8Array, box: Box): number {
  const p = box.start + box.headerSize;
  if (p + 8 <= box.start + box.size) {
    const maybeChildType = ascii(b, p + 4, 4);
    if (/^[a-z]{4}$/.test(maybeChildType) && u32be(b, p) >= 8) return p; // QuickTime style
  }
  return p + 4;
}

export function children(b: Uint8Array, box: Box): Box[] {
  const start = box.type === 'meta' ? metaChildrenStart(b, box) : box.start + box.headerSize;
  return readBoxes(b, start, box.start + box.size);
}

export function payload(b: Uint8Array, box: Box): Uint8Array {
  return b.subarray(box.start + box.headerSize, box.start + box.size);
}

/** Calls `visit` for every box in the tree under `boxes`, depth-first, with its path like "moov/trak/mdia". */
export function walk(b: Uint8Array, boxes: Box[], visit: (box: Box, path: string) => void, path = ''): void {
  for (const box of boxes) {
    const p = path ? `${path}/${box.type}` : box.type;
    visit(box, p);
    if (CONTAINERS.has(box.type)) {
      let kids: Box[] = [];
      try {
        kids = children(b, box);
      } catch {
        // A container we cannot read is reported by the caller through other checks; skip it here.
      }
      walk(b, kids, visit, p);
    }
  }
}

/** Reads the top-level box headers of a file, then loads only 'moov' (and small metadata boxes). */
export async function loadMovieHeader(src: ByteSource): Promise<{ top: Box[]; moov: Uint8Array; moovBoxes: Box[]; extras: string[] }> {
  const top: Box[] = [];
  const extras: string[] = [];
  let moov: Uint8Array | undefined;
  let o = 0;
  while (o + 8 <= src.size) {
    const h = await src.read(o, 16);
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64be(h, 8);
      headerSize = 16;
    } else if (size === 0) size = src.size - o;
    if (size < headerSize || o + size > src.size) throw new FormatError(`bad top-level box ${JSON.stringify(type)}`);
    top.push({ type, start: o, headerSize, size });
    if (type === 'moov') {
      if (size > 256 * 1024 * 1024) throw new FormatError('moov too large');
      moov = await src.read(o, size);
    } else if (!['ftyp', 'mdat', 'free', 'skip', 'wide', 'pnot'].includes(type)) {
      extras.push(type);
    }
    o += size;
  }
  if (!moov) throw new FormatError('no moov box');
  return { top, moov, moovBoxes: readBoxes(moov, 0, moov.length), extras };
}

/** Seconds between 1904-01-01 (QuickTime epoch) and 1970-01-01. */
const QT_EPOCH = 2082844800;

function readTimes(b: Uint8Array, box: Box): number {
  const p = box.start + box.headerSize;
  const version = b[p]!;
  return version === 1 ? u64be(b, p + 4) : u32be(b, p + 4);
}

function dataBoxValue(b: Uint8Array, box: Box): string | undefined {
  // An ilst item holds a 'data' box: type indicator (4) + locale (4) + value.
  for (const c of children(b, box)) {
    if (c.type !== 'data') continue;
    const p = payload(b, c);
    if (p.length < 8) return undefined;
    const typeIndicator = u32be(p, 0) & 0xffffff;
    if (typeIndicator === 1 || typeIndicator === 2 || typeIndicator === 0) return utf8(p.subarray(8));
    return undefined;
  }
  return undefined;
}

/** Text of a QuickTime '©xxx' user-data string: 2-byte length + 2-byte language + text. */
function qtString(b: Uint8Array, box: Box): string | undefined {
  const p = payload(b, box);
  if (p.length >= 4) {
    const n = (p[0]! << 8) | p[1]!;
    if (n > 0 && 4 + n <= p.length) return utf8(p.subarray(4, 4 + n));
  }
  return undefined;
}

const KEY_FINDINGS: [RegExp, Parameters<FindingList['add']>[0]][] = [
  [/location/i, 'videoLocation'],
  [/(make|model)$/i, 'deviceModel'],
  [/software|encoder/i, 'software'],
  [/creationdate|date/i, 'dateTaken'],
  [/author|artist|owner|copyright/i, 'owner'],
  [/serial/i, 'serialNumber'],
  [/comment|description/i, 'comment'],
];

const UDTA_FINDINGS: Record<string, Parameters<FindingList['add']>[0]> = {
  '©mak': 'deviceModel',
  '©mod': 'deviceModel',
  '©swr': 'software',
  '©too': 'software',
  '©day': 'dateTaken',
  '©ART': 'owner',
  '©aut': 'owner',
  '©cpy': 'owner',
  '©cmt': 'comment',
  '©des': 'comment',
};

export interface VideoInspection {
  findings: Finding[];
  /** Handler types of all tracks, e.g. ["vide", "soun", "text"]. */
  tracks: string[];
}

export function inspectMovie(moov: Uint8Array, moovBoxes: Box[], extras: string[] = []): VideoInspection {
  const out = new FindingList();
  const tracks: string[] = [];
  const keyNames: string[] = [];

  walk(moov, moovBoxes, (box, path) => {
    const t = box.type;
    if (t === 'mvhd' || t === 'tkhd' || t === 'mdhd') {
      const secs = readTimes(moov, box);
      if (secs > QT_EPOCH) out.add('dateTaken', new Date((secs - QT_EPOCH) * 1000));
    } else if (t === 'hdlr' && path.endsWith('mdia/hdlr')) {
      const p = payload(moov, box);
      if (p.length >= 12) tracks.push(ascii(p, 8, 4));
    } else if (t === '©xyz') {
      const s = qtString(moov, box) ?? dataBoxValue(moov, box);
      const g = s ? parseIso6709(s) : undefined;
      out.add('videoLocation', s, g);
    } else if (t === 'loci') {
      out.add('videoLocation');
    } else if (t === 'keys') {
      keyNames.length = 0;
      const p = payload(moov, box);
      const count = u32be(p, 4);
      let o = 8;
      for (let i = 0; i < count && o + 8 <= p.length; i++) {
        const size = u32be(p, o);
        if (size < 8 || o + size > p.length) break;
        keyNames.push(utf8(p.subarray(o + 8, o + size)));
        o += size;
      }
    } else if (path.endsWith('ilst/' + t) && keyNames.length && /^[\x00-\x01]/.test(t)) {
      const index = u32be(moov, box.start + 4) - 1;
      const name = keyNames[index] ?? '';
      const value = dataBoxValue(moov, box);
      for (const [re, id] of KEY_FINDINGS) {
        if (re.test(name)) {
          out.add(id, value, id === 'videoLocation' && value ? parseIso6709(value) : undefined);
          break;
        }
      }
      if (!KEY_FINDINGS.some(([re]) => re.test(name))) out.add('otherMetadata', name);
    } else if (UDTA_FINDINGS[t]) {
      out.add(UDTA_FINDINGS[t]!, qtString(moov, box) ?? dataBoxValue(moov, box));
    } else if (t === 'XMP_' || t === 'uuid') {
      out.add('xmp');
    } else if (path.startsWith('moov/udta/') && path.split('/').length === 3 && !['meta', 'free', 'skip'].includes(t)) {
      out.add('otherMetadata', t);
    }
  });

  const extraTracks = tracks.filter((h) => h !== 'vide' && h !== 'soun');
  if (extraTracks.length) out.add('extraTracks', extraTracks.join(', '));
  for (const e of extras) {
    if (e === 'uuid' || e === 'XMP_') out.add('xmp');
    else out.add('otherMetadata', e);
  }
  return { findings: out.items, tracks };
}

export async function inspectVideo(src: ByteSource): Promise<VideoInspection & { partial: boolean }> {
  try {
    const { moov, moovBoxes, extras } = await loadMovieHeader(src);
    return { ...inspectMovie(moov, moovBoxes, extras), partial: false };
  } catch {
    return { findings: [], tracks: [], partial: true };
  }
}

/**
 * Sets creation and modification times in mvhd, tkhd and mdhd to zero, in place.
 * Used on our own output, whose writer stamps the time of cleaning into the file.
 */
export function zeroMovieTimes(file: Uint8Array): number {
  let patched = 0;
  const top = readBoxes(file, 0, file.length);
  for (const t of top) {
    if (t.type !== 'moov') continue;
    walk(file, [t], (box) => {
      if (box.type !== 'mvhd' && box.type !== 'tkhd' && box.type !== 'mdhd') return;
      const p = box.start + box.headerSize;
      const width = file[p] === 1 ? 8 : 4;
      file.fill(0, p + 4, p + 4 + 2 * width);
      patched++;
    });
  }
  return patched;
}
