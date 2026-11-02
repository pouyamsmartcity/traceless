import {
  ALL_FORMATS,
  AudioSample,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_LOW,
  canEncodeAudio,
  canEncodeVideo,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
} from 'mediabunny';
import { PitchShifter, VOICE_DRIFT, randomVoiceRatio } from './voice';
import { sourceFromBlob, sourceFromBytes } from './bytes';
import { assertSaneMovie, inspectVideo, outputBoxProblems, zeroMovieTimes } from './bmff';
import { sanitizeMp4, streamLeftovers } from './sanitize-video';
import { VideoCleanError } from './video-errors';

export { VideoCleanError };

export interface SoundOptions {
  /** Leave the sound out. */
  mute?: boolean;
  /** Change voices (lower pitch and formants by a random factor). Ignored when `mute` is set. */
  voice?: boolean;
}

/** Longest side of a video made "light" (for slow or expensive internet). */
export const LIGHT_VIDEO_SIDE = 1280;

/** Output size for a light video: the longest side at most LIGHT_VIDEO_SIDE, even numbers (encoders need them). */
export function lightSize(w: number, h: number): { width: number; height: number } {
  const s = Math.min(1, LIGHT_VIDEO_SIDE / Math.max(w, h));
  const even = (v: number) => Math.max(2, Math.round((v * s) / 2) * 2);
  return { width: even(w), height: even(h) };
}

function cryptoRand(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! / 2 ** 32;
}

/**
 * How the sound is handled: copied unchanged, left out, or re-encoded with changed voices.
 * Throws VideoCleanError('cannotVoice') when voices should change but this browser cannot encode audio.
 */
export async function soundConversion(opts: SoundOptions): Promise<{ audio?: ConversionAudioOptions }> {
  if (opts.mute) return { audio: { discard: true } };
  if (!opts.voice) return {};
  if (typeof AudioEncoder === 'undefined') throw new VideoCleanError('cannotVoice', 'no audio encoder');
  const codec = (await canEncodeAudio('aac').catch(() => false)) ? 'aac' : (await canEncodeAudio('opus').catch(() => false)) ? 'opus' : null;
  if (!codec) throw new VideoCleanError('cannotVoice', 'no AAC or Opus encoder');
  const ratio = randomVoiceRatio(cryptoRand);
  const drift = { period: 3 + 4 * cryptoRand(), phase: 2 * Math.PI * cryptoRand() };
  let shifter: PitchShifter | undefined;
  return {
    audio: {
      codec,
      forceTranscode: true,
      process: (sample: AudioSample) => {
        const channels = sample.numberOfChannels;
        const frames = sample.numberOfFrames;
        shifter ??= new PitchShifter(ratio, sample.sampleRate, channels);
        // The factor wanders slowly (+/-0.04 over a few seconds), so no single factor undoes it exactly.
        shifter.ratio = ratio + VOICE_DRIFT * Math.sin((2 * Math.PI * sample.timestamp) / drift.period + drift.phase);
        const planes: Float32Array[] = [];
        for (let c = 0; c < channels; c++) {
          const plane = new Float32Array(frames);
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          planes.push(plane);
        }
        const out = shifter.process(planes);
        const data = new Float32Array(frames * channels);
        out.forEach((p, c) => data.set(p, c * frames));
        return new AudioSample({ data, format: 'f32-planar', numberOfChannels: channels, sampleRate: sample.sampleRate, timestamp: sample.timestamp });
      },
    },
  };
}

export interface CleanVideoResult {
  bytes: Uint8Array;
  /** Tracks of the input that were left out (data tracks such as GPS, subtitles, timecode). */
  droppedTracks: number;
  /** Whether the new video has sound. */
  audioKept: boolean;
  /** Whether the picture was made smaller (light option). */
  light?: boolean;
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
  opts: SoundOptions & { light?: boolean } = {},
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
    try {
      await assertSaneMovie(sourceFromBlob(file));
    } catch (e) {
      throw new VideoCleanError('unsupported', e instanceof Error ? e.message : String(e));
    }
    const before = await inspectVideo(sourceFromBlob(file));
    // Light: a smaller picture at a lower bitrate (the video is re-encoded; otherwise it is copied as it is).
    let video: ConversionVideoOptions | undefined;
    if (opts.light) {
      const track = await input.getPrimaryVideoTrack().catch(() => null);
      if (track) {
        const size = lightSize(await track.getDisplayWidth(), await track.getDisplayHeight());
        // A device that cannot encode H.264 keeps the full size (the card says so).
        if (typeof VideoEncoder !== 'undefined' && (await canEncodeVideo('avc', size).catch(() => false))) {
          video = { codec: 'avc', ...size, fit: 'contain', bitrate: QUALITY_LOW, forceTranscode: true, allowTransformationMetadata: false };
        }
      }
    }
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
      // Voices and background sounds can identify people and places: sound can be left out or changed.
      ...(await soundConversion(opts)),
      ...(video ? { video } : {}),
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
    return {
      bytes,
      droppedTracks: Math.max(0, before.tracks.length - conversion.utilizedTracks.length),
      audioKept: conversion.utilizedTracks.some((t) => t.isAudioTrack()),
      light: !!video,
    };
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
