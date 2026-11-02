import exifr from 'exifr';
import { ascii, indexOfAscii, startsWith, u32le, utf8 } from './bytes';
import { FindingList, validGeo, type Finding } from './findings';
import { appIdentifier, parseJpeg } from './jpeg';
import { parsePng } from './png';
import { inspectXmp } from './xmp';

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'gif' | 'bmp' | 'tiff' | 'unknown';

export function sniffImage(b: Uint8Array): ImageKind {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (/^(avif|avis)$/.test(brand)) return 'avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
  }
  if (b.length >= 6 && ascii(b, 0, 3) === 'GIF') return 'gif';
  if (b.length >= 2 && ascii(b, 0, 2) === 'BM') return 'bmp';
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  return 'unknown';
}

/** Signs that a received photo was edited or re-saved. Hints for checking a source, never proof. */
export type HintId = 'editingSoftware' | 'dateMismatch' | 'thumbnailDiffers' | 'noCameraData';

export interface Hint {
  id: HintId;
  value?: string;
}

export interface ImageInspection {
  kind: ImageKind;
  findings: Finding[];
  hints: Hint[];
  /** The embedded thumbnail (JPEG), for comparing with the picture in the browser. */
  thumbnail?: Uint8Array;
  /** EXIF orientation (1-8) if present. Browsers apply it when drawing, we only report it. */
  orientation?: number;
  /** True when the structure could not be fully read; findings may be incomplete. */
  partial: boolean;
}

interface Containers {
  /** Data to give to exifr: the whole file when exifr understands the format, else a bare TIFF block. */
  exifInput?: Uint8Array;
  xmp: string[];
}

function scanJpeg(b: Uint8Array, out: FindingList): Containers {
  const c: Containers = { exifInput: b, xmp: [] };
  const { segments, trailing } = parseJpeg(b);
  for (const s of segments) {
    const m = s.marker;
    if (m === 0xfe) out.add('comment', utf8(s.payload));
    if (m < 0xe0 || m > 0xef) continue;
    const id = appIdentifier(s);
    if (m === 0xe1 && id === 'http://ns.adobe.com/xap/1.0/') c.xmp.push(utf8(s.payload.subarray(id.length + 1)));
    else if (m === 0xe1 && id === 'http://ns.adobe.com/xmp/extension/') c.xmp.push(utf8(s.payload.subarray(id.length + 1 + 40)));
    else if (m === 0xe2 && id === 'ICC_PROFILE') out.add('colorProfile');
    else if (m === 0xe2 && id === 'MPF') out.add('extraImages');
    else if (m === 0xeb && (indexOfAscii(s.payload, 'jumb') >= 0 || id.startsWith('JP'))) out.add('contentCredentials');
    else if (m === 0xed) out.add('iptc');
    else if (m !== 0xe0 && m !== 0xe1 && m !== 0xee) out.add('otherMetadata', id || `APP${m - 0xe0}`);
  }
  if (trailing > 0) {
    const tail = b.subarray(b.length - trailing);
    if (indexOfAscii(tail, 'ftyp') >= 0) out.add('motionPhoto');
    else if (trailing > 16) out.add('trailingData', `${trailing} bytes`);
  }
  return c;
}

function scanPng(b: Uint8Array, out: FindingList): Containers {
  const c: Containers = { exifInput: b, xmp: [] };
  const { chunks, trailing } = parsePng(b);
  for (const ch of chunks) {
    if (ch.type === 'iTXt' || ch.type === 'tEXt' || ch.type === 'zTXt') {
      const kwEnd = ch.data.indexOf(0);
      const keyword = utf8(ch.data.subarray(0, kwEnd < 0 ? Math.min(79, ch.data.length) : kwEnd));
      if (keyword === 'XML:com.adobe.xmp') {
        const start = indexOfAscii(ch.data, '<');
        c.xmp.push(start >= 0 ? utf8(ch.data.subarray(start)) : '');
      } else if (ch.type === 'tEXt' && kwEnd >= 0) {
        out.add('textChunks', `${keyword}: ${utf8(ch.data.subarray(kwEnd + 1))}`);
      } else {
        out.add('textChunks', keyword);
      }
    } else if (ch.type === 'tIME') out.add('dateTaken');
    else if (ch.type === 'iCCP') out.add('colorProfile');
    else if (ch.type === 'caBX') out.add('contentCredentials');
    else if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'eXIf', 'gAMA', 'cHRM', 'sRGB', 'pHYs', 'sBIT', 'bKGD'].includes(ch.type)) {
      out.add('otherMetadata', ch.type);
    }
  }
  if (trailing > 0) out.add('trailingData', `${trailing} bytes`);
  return c;
}

function scanWebp(b: Uint8Array, out: FindingList): Containers {
  const c: Containers = { xmp: [] };
  let o = 12;
  while (o + 8 <= b.length) {
    const type = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    const data = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
    if (type === 'EXIF') c.exifInput = startsWith(data, [0x45, 0x78, 0x69, 0x66, 0, 0]) ? data.subarray(6) : data;
    else if (type === 'XMP ') c.xmp.push(utf8(data));
    else if (type === 'ICCP') out.add('colorProfile');
    else if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF'].includes(type)) out.add('otherMetadata', type.trim());
    o += 8 + size + (size & 1);
  }
  return c;
}

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | undefined {
  return v && typeof v === 'object' && !(v instanceof Uint8Array) ? (v as Dict) : undefined;
}

const EDITORS = /photoshop|lightroom|gimp|snapseed|picsart|canva|pixelmator|affinity|facetune|vsco|meitu|luminar|capture one|paint\.net|krita/i;

/** EXIF date "2026:09:21 18:30:00" (or a Date) as milliseconds, or undefined. */
function exifTime(v: unknown): number | undefined {
  if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v.getTime();
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : undefined;
}

async function readExif(input: Uint8Array, out: FindingList, hints: Hint[]): Promise<number | undefined> {
  const data = asDict(
    await exifr.parse(input, {
      tiff: true,
      ifd0: true,
      exif: true,
      gps: true,
      ifd1: true,
      interop: false,
      xmp: false,
      iptc: true,
      icc: false,
      jfif: false,
      ihdr: false,
      makerNote: true,
      userComment: true,
      mergeOutput: false,
      translateValues: false,
      sanitize: true,
    } as never),
  );
  if (!data) return undefined;
  const ifd0 = asDict(data.ifd0) ?? {};
  const exif = asDict(data.exif) ?? {};
  const gps = asDict(data.gps);
  const ifd1 = asDict(data.ifd1);
  const iptc = asDict(data.iptc);

  if (gps) {
    const g = validGeo(gps.latitude, gps.longitude, gps.GPSAltitude);
    if (g) out.add('gps', `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`, g);
    else if (Object.keys(gps).some((k) => k !== 'GPSVersionID')) out.add('gps');
    if (gps.GPSDateStamp) out.add('dateTaken', `${String(gps.GPSDateStamp)} (GPS)`);
  }
  const model = [ifd0.Make, ifd0.Model].filter(Boolean).join(' ');
  if (model) out.add('deviceModel', model);
  for (const k of ['BodySerialNumber', 'SerialNumber', 'CameraSerialNumber', 'LensSerialNumber', 'InternalSerialNumber']) {
    if (exif[k] ?? ifd0[k]) out.add('serialNumber', exif[k] ?? ifd0[k]);
  }
  if (exif.LensModel || exif.LensMake) out.add('lens', [exif.LensMake, exif.LensModel].filter(Boolean).join(' '));
  if (ifd0.Software) out.add('software', ifd0.Software);
  const taken = exif.DateTimeOriginal ?? exif.CreateDate ?? ifd0.ModifyDate;
  if (taken) out.add('dateTaken', taken);
  const tz = exif.OffsetTimeOriginal ?? exif.OffsetTime;
  if (tz) out.add('timeZone', tz);
  for (const k of ['Artist', 'Copyright', 'OwnerName', 'CameraOwnerName', 'XPAuthor']) {
    if (ifd0[k] ?? exif[k]) out.add('owner', ifd0[k] ?? exif[k]);
  }
  if (exif.ImageUniqueID) out.add('uniqueId', exif.ImageUniqueID);
  for (const k of ['UserComment', 'ImageDescription', 'XPComment']) {
    if (exif[k] ?? ifd0[k]) out.add('comment', exif[k] ?? ifd0[k]);
  }
  if (exif.MakerNote) out.add('makerNotes');
  if (ifd1 && (ifd1.ThumbnailOffset || ifd1.JPEGInterchangeFormat || ifd1.ThumbnailLength)) out.add('thumbnail');
  if (iptc && Object.keys(iptc).length) {
    out.add('iptc');
    for (const k of ['City', 'Sublocation', 'State', 'Country']) if (iptc[k]) out.add('cityName', iptc[k]);
    for (const k of ['Byline', 'Credit', 'Writer']) if (iptc[k]) out.add('owner', iptc[k]);
  }
  const software = [ifd0.Software, ifd0.ProcessingSoftware].find((v) => typeof v === 'string' && EDITORS.test(v));
  if (software) hints.push({ id: 'editingSoftware', value: String(software) });
  const original = exifTime(exif.DateTimeOriginal);
  const modified = exifTime(ifd0.ModifyDate);
  if (original !== undefined && modified !== undefined && Math.abs(modified - original) > 60_000) {
    hints.push({ id: 'dateMismatch', value: `${String(exif.DateTimeOriginal)} → ${String(ifd0.ModifyDate)}` });
  }
  const o = Number(ifd0.Orientation);
  return Number.isInteger(o) && o >= 1 && o <= 8 ? o : undefined;
}

/** Width and height stored in a JPEG's frame header. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  try {
    const sof = parseJpeg(b).segments.find((s) => s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker));
    if (!sof || sof.payload.length < 5) return undefined;
    const height = (sof.payload[1]! << 8) | sof.payload[2]!;
    const width = (sof.payload[3]! << 8) | sof.payload[4]!;
    return width && height ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

/** Lists everything an image file reveals about where, when, how and by whom it was made. */
export async function inspectImage(b: Uint8Array): Promise<ImageInspection> {
  const kind = sniffImage(b);
  const out = new FindingList();
  let partial = false;
  let containers: Containers = { xmp: [] };
  try {
    if (kind === 'jpeg') containers = scanJpeg(b, out);
    else if (kind === 'png') containers = scanPng(b, out);
    else if (kind === 'webp') containers = scanWebp(b, out);
    else if (kind === 'heic' || kind === 'avif' || kind === 'tiff') {
      containers = { exifInput: b, xmp: [] };
      // HEIF files often hold more than one picture (depth maps, bursts, Live Photo links).
      if (kind !== 'tiff') out.add('extraImages');
    }
  } catch {
    partial = true;
  }
  let orientation: number | undefined;
  const hints: Hint[] = [];
  if (containers.exifInput) {
    try {
      orientation = await readExif(containers.exifInput, out, hints);
    } catch {
      partial = true;
    }
  }
  // A camera photo without any camera data was probably re-saved, edited or sent through a messenger.
  if ((kind === 'jpeg' || kind === 'webp' || kind === 'heic') && !out.has('deviceModel') && !out.has('dateTaken')) {
    hints.push({ id: 'noCameraData' });
  }
  for (const x of containers.xmp) inspectXmp(x, out);
  const result: ImageInspection = { kind, findings: out.items, hints, partial };
  if (orientation !== undefined) result.orientation = orientation;
  if (kind === 'jpeg' && out.has('thumbnail')) {
    try {
      const thumb = await exifr.thumbnail(b);
      if (thumb && thumb.length) {
        // Compared with the picture in the browser (pixels), where both can be decoded.
        result.thumbnail = new Uint8Array(thumb);
      }
    } catch {
      // A broken thumbnail is not a reason to stop.
    }
  }
  return result;
}
