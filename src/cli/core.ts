import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { audioFindings, audioLeftovers, cleanAudio } from '../lib/clean-audio';
import { imageLeftovers } from '../lib/clean-image';
import { cleanVideo, videoLeftovers } from '../lib/clean-video';
import { inspectVideo } from '../lib/bmff';
import { sourceFromBytes } from '../lib/bytes';
import type { Finding } from '../lib/findings';
import { inspectImage, sniffImage } from '../lib/inspect-image';
import { STRINGS } from '../ui/i18n';
import { decodePixels, encodeClean, orient, paintSolid, type NodeCover } from './image-node';

/**
 * Traceless without a browser: the functions behind the command-line tool and the agent (MCP) tools.
 * Everything runs locally; nothing is sent anywhere.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'unknown';

export interface Leak {
  /** Stable identifier (see docs/API.md). */
  id: Finding['id'];
  severity: Finding['severity'];
  /** Plain-English description. */
  label: string;
  /** The value found in the file, if any. */
  value?: string;
  /** For locations: latitude and longitude. */
  geo?: { lat: number; lon: number; alt?: number };
}

export interface InspectReport {
  kind: MediaKind;
  /** File format, e.g. "jpeg", "mp4". */
  format: string;
  /** What the file reveals (empty when nothing was found). */
  leaks: Leak[];
  /** Signs that a photo was edited or re-saved (hints, not proof). */
  hints: { id: string; label: string; value?: string }[];
  /** True when part of the file could not be read: the list may be incomplete. */
  partial: boolean;
}

export interface CleanOptions {
  /** Solid covers to paint on a photo (pixels of the upright picture). Not available for videos here. */
  covers?: NodeCover[];
  /** Cover colour as #rrggbb (default black). */
  color?: string;
}

export interface CleanResult {
  kind: MediaKind;
  bytes: Uint8Array;
  /** File extension for the new file. */
  ext: string;
  mime: string;
  /** What the original revealed (all of it is gone from the new file). */
  removed: Leak[];
  /** Plain-English notes about what was done. */
  notes: string[];
}

const en = STRINGS.en;

function toLeak(f: Finding): Leak {
  const l: Leak = { id: f.id, severity: f.severity, label: en.findings[f.id] };
  if (f.value) l.value = f.value;
  if (f.geo) l.geo = f.geo;
  return l;
}

async function hasTracks(bytes: Uint8Array): Promise<{ video: boolean; audio: boolean; format: string }> {
  const input = new Input({ source: new BlobSource(new Blob([bytes as BlobPart])), formats: ALL_FORMATS });
  try {
    const format = (await input.getFormat().catch(() => null))?.name ?? 'unknown';
    const video = !!(await input.getPrimaryVideoTrack().catch(() => null));
    const audio = !!(await input.getPrimaryAudioTrack().catch(() => null));
    return { video, audio, format };
  } catch {
    return { video: false, audio: false, format: 'unknown' };
  } finally {
    input.dispose();
  }
}

/** Decides what a file is from its content (never from its name). */
export async function kindOf(bytes: Uint8Array): Promise<{ kind: MediaKind; format: string }> {
  const img = sniffImage(bytes);
  if (img !== 'unknown') return { kind: 'image', format: img };
  const t = await hasTracks(bytes);
  if (t.video) return { kind: 'video', format: t.format };
  if (t.audio) return { kind: 'audio', format: t.format };
  return { kind: 'unknown', format: t.format };
}

/** What a photo, video or recording reveals: location, device, time, people and more. */
export async function inspect(bytes: Uint8Array): Promise<InspectReport> {
  const { kind, format } = await kindOf(bytes);
  if (kind === 'image') {
    const r = await inspectImage(bytes);
    return {
      kind,
      format,
      leaks: r.findings.map(toLeak),
      hints: r.hints.map((h) => ({ id: h.id, label: en.hints[h.id], ...(h.value ? { value: h.value } : {}) })),
      partial: r.partial,
    };
  }
  if (kind === 'video') {
    const r = await inspectVideo(sourceFromBytes(bytes));
    return { kind, format, leaks: r.findings.map(toLeak), hints: [], partial: r.partial };
  }
  if (kind === 'audio') {
    const input = new Input({ source: new BlobSource(new Blob([bytes as BlobPart])), formats: ALL_FORMATS });
    try {
      const findings = audioFindings(await input.getMetadataTags().catch(() => ({})));
      const boxes = await inspectVideo(sourceFromBytes(bytes));
      for (const f of boxes.findings) if (!findings.some((g) => g.id === f.id && g.value === f.value)) findings.push(f);
      return { kind, format, leaks: findings.map(toLeak), hints: [], partial: false };
    } finally {
      input.dispose();
    }
  }
  return { kind, format, leaks: [], hints: [], partial: true };
}

function hexColor(c: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c ?? '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Makes a safe copy. Photos (JPEG, PNG) are redrawn from their pixels, with optional solid covers; videos are
 * rebuilt with only picture and sound (no covering here: use the app for faces in videos); recordings are put
 * in a fresh M4A. Every result is checked again; a file that fails the check is never returned.
 */
export async function clean(bytes: Uint8Array, opts: CleanOptions = {}): Promise<CleanResult> {
  const report = await inspect(bytes);
  const notes: string[] = [];
  if (report.kind === 'image') {
    const { pixels, type } = decodePixels(bytes);
    const meta = await inspectImage(bytes);
    const upright = orient(pixels, meta.orientation);
    if (opts.covers?.length) {
      paintSolid(upright, opts.covers, hexColor(opts.color));
      notes.push(`${opts.covers.length} area(s) covered with solid colour.`);
    }
    const out = await encodeClean(upright, type);
    notes.push('The picture was redrawn from its pixels into a new file; nothing of the original file was copied.');
    return { kind: 'image', bytes: out, ext: type === 'image/png' ? 'png' : 'jpg', mime: type, removed: report.leaks, notes };
  }
  if (report.kind === 'video') {
    if (opts.covers?.length) throw new Error('covering in videos needs the Traceless app (it re-encodes the picture)');
    const r = await cleanVideo(new Blob([bytes as BlobPart]));
    notes.push('The video was rebuilt with only its picture and sound; picture and sound themselves were not changed.');
    if (r.droppedTracks) notes.push(`${r.droppedTracks} extra track(s) (such as GPS tracks or subtitles) were left out.`);
    notes.push('Faces and plates were NOT covered: use the Traceless app for that.');
    return { kind: 'video', bytes: r.bytes, ext: 'mp4', mime: 'video/mp4', removed: report.leaks, notes };
  }
  if (report.kind === 'audio') {
    const r = await cleanAudio(new Blob([bytes as BlobPart]));
    notes.push('The sound was put into a new M4A file with no tags. The voice was NOT changed: use the Traceless app for that.');
    if (r.droppedPicture) notes.push('The file also had a picture; only the sound was kept.');
    return { kind: 'audio', bytes: r.bytes, ext: 'm4a', mime: 'audio/mp4', removed: report.leaks, notes };
  }
  throw new Error('not a photo, video or recording Traceless can read');
}

/** Independent check of a file: does it still reveal anything? (Use it on files cleaned by any tool.) */
export async function check(bytes: Uint8Array): Promise<{ kind: MediaKind; clean: boolean; problems: string[]; leaks: Leak[] }> {
  const report = await inspect(bytes);
  let problems: string[] = [];
  if (report.kind === 'image') {
    const kind = sniffImage(bytes);
    problems = kind === 'jpeg' || kind === 'png' ? await imageLeftovers(bytes, kind === 'png' ? 'image/png' : 'image/jpeg') : report.leaks.map((l) => l.id);
  } else if (report.kind === 'video') problems = await videoLeftovers(bytes);
  else if (report.kind === 'audio') problems = await audioLeftovers(bytes);
  else problems = ['not a photo, video or recording Traceless can read'];
  return { kind: report.kind, clean: problems.length === 0 && report.leaks.length === 0, problems, leaks: report.leaks };
}
