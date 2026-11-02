import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from 'mediabunny';
import { sourceFromBlob, sourceFromBytes } from './bytes';
import { inspectVideo, outputBoxProblems, zeroMovieTimes } from './bmff';
import { sanitizeMp4, streamLeftovers } from './sanitize-video';
import { VideoCleanError } from './video-errors';

export { VideoCleanError };

export interface CleanVideoResult {
  bytes: Uint8Array;
  /** Tracks of the input that were left out (data tracks such as GPS, subtitles, timecode). */
  droppedTracks: number;
}

/**
 * Re-packages a video into a fresh MP4 that holds only the main picture track and the main sound track.
 * The encoded picture and sound are copied as they are (no quality loss) when possible.
 * All container metadata (location, device, dates, data tracks) is left behind, and the
 * creation times our writer stamps into the new file are set to zero.
 */
export async function cleanVideo(
  file: Blob,
  onProgress?: (fraction: number) => void,
): Promise<CleanVideoResult> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    let format;
    try {
      format = await input.getFormat();
    } catch {
      throw new VideoCleanError('unsupported', 'unknown video format');
    }
    if (!format) throw new VideoCleanError('unsupported', 'unknown video format');
    const before = await inspectVideo(sourceFromBlob(file));
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      tags: {},
      showWarnings: false,
    });
    const keptVideo = conversion.utilizedTracks.some((t) => t.isVideoTrack());
    if (!conversion.isValid || !keptVideo) {
      throw new VideoCleanError('noVideo', 'no usable video track');
    }
    if (onProgress) conversion.onProgress = (p) => onProgress(Math.max(0, Math.min(1, p)));
    try {
      await conversion.execute();
    } catch (e) {
      throw new VideoCleanError('failed', e instanceof Error ? e.message : String(e));
    }
    const buffer = target.buffer;
    if (!buffer) throw new VideoCleanError('failed', 'no output');
    const bytes = await finishVideo(new Uint8Array(buffer));
    return { bytes, droppedTracks: Math.max(0, before.tracks.length - conversion.utilizedTracks.length) };
  } finally {
    input.dispose();
  }
}

/**
 * Last step for every video we make: rebuild it without track names, tags or metadata units in the video
 * stream, zero the dates our writer stamps in, and check the result three independent ways.
 * Throws instead of returning anything that fails a check.
 */
export async function finishVideo(converted: Uint8Array): Promise<Uint8Array> {
  const bytes = await sanitizeMp4(converted);
  zeroMovieTimes(bytes);
  const leftovers = await videoLeftovers(bytes);
  if (leftovers.length) throw new VideoCleanError('leftovers', leftovers.join('; '));
  return bytes;
}

/** Independent check of a cleaned video. Returns what is still revealing, or an empty list. */
export async function videoLeftovers(bytes: Uint8Array): Promise<string[]> {
  const r = await inspectVideo(sourceFromBytes(bytes));
  if (r.partial) return ['could not read the output file'];
  const problems = r.findings.map((f) => (f.value ? `${f.id}: ${f.value}` : f.id));
  if (r.tracks.length === 0 || r.tracks.length > 2) problems.push(`tracks: ${r.tracks.join(',')}`);
  problems.push(...outputBoxProblems(bytes));
  problems.push(...(await streamLeftovers(bytes)));
  return problems;
}
