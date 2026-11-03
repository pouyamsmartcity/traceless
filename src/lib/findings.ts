/** What a file reveals. The UI turns each finding into a plain-language sentence. */

export type FindingId =
  | 'gps'
  | 'videoLocation'
  | 'cityName'
  | 'deviceModel'
  | 'serialNumber'
  | 'lens'
  | 'software'
  | 'dateTaken'
  | 'timeZone'
  | 'owner'
  | 'uniqueId'
  | 'thumbnail'
  | 'editHistory'
  | 'xmp'
  | 'iptc'
  | 'contentCredentials'
  | 'comment'
  | 'makerNotes'
  | 'motionPhoto'
  | 'trailingData'
  | 'extraImages'
  | 'colorProfile'
  | 'textChunks'
  | 'extraTracks'
  | 'otherMetadata';

export type Severity = 'high' | 'medium' | 'low';

export interface GeoPoint {
  lat: number;
  lon: number;
  alt?: number;
}

export interface Finding {
  id: FindingId;
  severity: Severity;
  /** The leaked value as found in the file, for showing the user (always rendered as text, never HTML). */
  value?: string;
  geo?: GeoPoint;
}

export const SEVERITY: Record<FindingId, Severity> = {
  gps: 'high',
  videoLocation: 'high',
  cityName: 'high',
  owner: 'high',
  serialNumber: 'high',
  uniqueId: 'medium',
  deviceModel: 'medium',
  lens: 'low',
  software: 'low',
  dateTaken: 'medium',
  timeZone: 'medium',
  thumbnail: 'medium',
  editHistory: 'medium',
  xmp: 'low',
  iptc: 'medium',
  contentCredentials: 'medium',
  comment: 'medium',
  makerNotes: 'medium',
  motionPhoto: 'high',
  trailingData: 'high',
  extraImages: 'medium',
  colorProfile: 'low',
  textChunks: 'medium',
  extraTracks: 'high',
  otherMetadata: 'low',
};

export class FindingList {
  readonly items: Finding[] = [];
  private readonly seen = new Set<string>();

  add(id: FindingId, value?: unknown, geo?: GeoPoint): void {
    const text = cleanValue(value);
    const key = `${id}|${text ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const f: Finding = { id, severity: SEVERITY[id] };
    if (text !== undefined) f.value = text;
    if (geo) f.geo = geo;
    this.items.push(f);
  }

  has(id: FindingId): boolean {
    return this.items.some((f) => f.id === id);
  }
}

/** Turns a raw metadata value into a short, printable string (or undefined when empty). */
export function cleanValue(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  if (v instanceof Date) s = isNaN(v.getTime()) ? '' : v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  else if (Array.isArray(v)) s = v.map((x) => cleanValue(x) ?? '').filter(Boolean).join(', ');
  else if (typeof v === 'object') return undefined;
  else s = String(v);
  // Remove control characters and limit length so odd files cannot flood the screen.
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

export function validGeo(lat: unknown, lon: unknown, alt?: unknown): GeoPoint | undefined {
  if (typeof lat !== 'number' || typeof lon !== 'number') return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  if (lat === 0 && lon === 0) return undefined;
  const g: GeoPoint = { lat, lon };
  if (typeof alt === 'number' && Number.isFinite(alt)) g.alt = alt;
  return g;
}

/** Parses ISO 6709 strings such as "+35.6997+051.3380+1190.000/" used by phones in videos. */
export function parseIso6709(s: string): GeoPoint | undefined {
  const m = /^\s*([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(s);
  if (!m) return undefined;
  return validGeo(parseFloat(m[1]!), parseFloat(m[2]!), m[3] !== undefined ? parseFloat(m[3]) : undefined);
}
