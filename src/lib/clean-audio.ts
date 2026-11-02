import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, canEncodeAudio, type ConversionAudioOptions, type MetadataTags } from 'mediabunny';
import { sourceFromBlob, sourceFromBytes } from './bytes';
import { inspectVideo, outputBoxProblems, zeroMovieTimes } from './bmff';
import { soundConversion } from './clean-video';
import { SEVERITY, type Finding, type FindingId } from './findings';
import { VideoCleanError } from './video-errors';

export { isAudioFile } from './media-kind';

/**
 * Voice notes and other sound recordings: a recording can carry its title (iPhone voice memos are named after
 * the place), the recorder's name, the date, the recording app, a cover picture and sometimes a location.
 * The sound is decoded and encoded again into a fresh M4A file that holds nothing else, optionally with the
 * voice changed, and the result is checked like a video.
 */

export interface CleanAudioResult {
  bytes: Uint8Array;
  /** What the original file revealed. */
  findings: Finding[];
  /** The file type of the result (AAC in MP4, or Opus in MP4 where this browser has no AAC encoder). */
  type: 'audio/mp4';
}


function add(out: Finding[], id: FindingId, value?: string): void {
  const f: Finding = { id, severity: SEVERITY[id] };
  if (value) f.value = value.slice(0, 200);
  out.push(f);
}

/** Turns the tags of a recording into findings (what the file tells about the speaker, place and time). */
export function audioFindings(tags: MetadataTags): Finding[] {
  const out: Finding[] = [];
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (text(tags.title)) add(out, 'comment', text(tags.title));
  if (text(tags.description)) add(out, 'comment', text(tags.description));
  if (text(tags.comment)) add(out, 'comment', text(tags.comment));
  if (text(tags.lyrics)) add(out, 'comment', text(tags.lyrics));
  for (const who of [tags.artist, tags.albumArtist]) if (text(who)) add(out, 'owner', text(who));
  if (tags.date instanceof Date && !Number.isNaN(tags.date.getTime())) add(out, 'dateTaken', tags.date.toISOString().replace('T', ' ').slice(0, 19));
  if (tags.images?.length) add(out, 'extraImages', String(tags.images.length));
  const known = new Set(out.map((f) => f.value));
  for (const [key, value] of Object.entries(tags.raw ?? {})) {
    const v = typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : '';
    if (/location|iso6709|©xyz|gps/i.test(key)) add(out, 'videoLocation', v || key);
    else if (/encod|software|©too|tsse|tool|vendor/i.test(key)) add(out, 'software', v || key);
    else if (/date|time|tdrc|tyer|©day|creation/i.test(key)) {
      if (v && !known.has(v)) add(out, 'dateTaken', v);
    } else if (/make|model|device/i.test(key)) add(out, 'deviceModel', v || key);
    else if (v && !known.has(v)) add(out, 'otherMetadata', `${key}: ${v}`);
  }
  return out;
}

/**
 * Makes a clean M4A from any sound file this browser can read. Throws VideoCleanError: 'unsupported' when the
 * file cannot be read, 'cannotVoice' when no audio encoder exists, 'leftovers' when the check fails.
 */
export async function cleanAudio(file: Blob, opts: { voice?: boolean; light?: boolean; onProgress?: (f: number) => void } = {}): Promise<CleanAudioResult> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack().catch(() => null);
    if (!track) throw new VideoCleanError('unsupported', 'no sound in this file');
    const findings = audioFindings(await input.getMetadataTags().catch(() => ({})));
    // MP4/M4A originals: also what our own reader finds in the file's boxes (location, device, dates).
    const boxes = await inspectVideo(sourceFromBlob(file));
    for (const f of boxes.findings) if (!findings.some((g) => g.id === f.id && g.value === f.value)) findings.push(f);

    // Always encoded again: nothing from the original stream is copied.
    // Without any encoder nothing can be made (with a voice change asked, the user is offered to keep the voice).
    const codec =
      typeof AudioEncoder === 'undefined'
        ? null
        : (await canEncodeAudio('aac').catch(() => false))
          ? ('aac' as const)
          : (await canEncodeAudio('opus').catch(() => false))
            ? ('opus' as const)
            : null;
    if (!codec) throw new VideoCleanError(opts.voice ? 'cannotVoice' : 'unsupported', 'no AAC or Opus encoder');
    // Speech needs little: 64 kbit/s (32 when made light) keeps a voice note clear and small.
    const bitrate = opts.light ? 32_000 : 64_000;
    const sound: { audio?: ConversionAudioOptions } = opts.voice ? await soundConversion({ voice: true }) : { audio: { codec, forceTranscode: true, bitrate } };
    if (sound.audio && !Array.isArray(sound.audio) && typeof sound.audio === 'object') sound.audio.bitrate = bitrate;

    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({ input, output, tracks: 'primary', tags: {}, showWarnings: false, video: { discard: true }, ...sound });
    if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.isAudioTrack())) throw new VideoCleanError('unsupported', 'sound cannot be converted');
    if (opts.onProgress) conversion.onProgress = (p) => opts.onProgress!(Math.max(0, Math.min(1, p)));
    try {
      await conversion.execute();
    } catch (e) {
      throw new VideoCleanError('failed', e instanceof Error ? e.message : String(e));
    }
    if (!target.buffer) throw new VideoCleanError('failed', 'no output');
    const bytes = new Uint8Array(target.buffer);
    zeroMovieTimes(bytes);
    const problems = await audioLeftovers(bytes);
    if (problems.length) throw new VideoCleanError('leftovers', problems.join('; '));
    return { bytes, findings, type: 'audio/mp4' };
  } finally {
    input.dispose();
  }
}

/** Independent check of a cleaned recording: one sound track, our own boxes only, nothing found by the reader. */
export async function audioLeftovers(bytes: Uint8Array): Promise<string[]> {
  const r = await inspectVideo(sourceFromBytes(bytes));
  if (r.partial) return ['could not read the output file'];
  const problems = r.findings.map((f) => (f.value ? `${f.id}: ${f.value}` : f.id));
  if (r.tracks.length !== 1) problems.push(`tracks: ${r.tracks.join(',')}`);
  problems.push(...outputBoxProblems(bytes));
  const input = new Input({ source: new BlobSource(new Blob([bytes as BlobPart])), formats: ALL_FORMATS });
  try {
    if (await input.getPrimaryVideoTrack().catch(() => null)) problems.push('picture track');
    const tags = await input.getMetadataTags().catch(() => ({}) as MetadataTags);
    if (audioFindings(tags).length) problems.push('tags');
  } finally {
    input.dispose();
  }
  return problems;
}
