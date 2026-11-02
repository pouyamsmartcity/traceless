import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  canEncodeVideo,
  type VideoSample,
} from 'mediabunny';
import { sourceFromBlob } from './bytes';
import { assertSaneMovie, inspectVideo } from './bmff';
import { finishVideo, soundConversion, type CleanVideoResult } from './clean-video';
import type { Detector } from './detect/detector';
import { paintCovers, sampleColors, shrinkOutline, type MaskStyle } from './masks';
import { masksAt, sampleTimes, type TimedBoxes } from './video-timeline';
import { VideoCleanError } from './video-errors';

/** How often to look for faces, in seconds. Masks between samples are interpolated (see video-timeline). */
const SAMPLE_STEP = 1 / 3;
/** Above this length (seconds) the re-encoded video uses medium instead of high quality. */
const LONG_VIDEO_SECONDS = 180;
/** Above this many people in a sampled frame, people get plain covers instead of outlines. */
const MAX_OUTLINED_PEOPLE = 8;
/** Person outlines are kept at this many cells per side in videos. */
const VIDEO_OUTLINE_CELLS = 80;
/** Memory for person outlines in one video; after that, people get plain covers (as safe, less shaped). */
const MAX_OUTLINE_BYTES = 32 * 1024 * 1024;
/** Longest side of the frames the detectors look at. */
const DETECT_SIDE = 1280;

export interface MaskedVideoOptions {
  faces: boolean;
  plates: boolean;
  /** Also cover text (signs, names, numbers). */
  text?: boolean;
  /** Also cover whole people. */
  people?: boolean;
  /** How covers look. */
  style?: MaskStyle;
  /** Leave the sound out. */
  mute?: boolean;
  /** Change voices. */
  voice?: boolean;
  onProgress?: (phase: 'detect' | 'encode', fraction: number) => void;
  signal?: AbortSignal;
}

export interface MaskedVideoResult extends CleanVideoResult {
  /** Number of sampled frames in which something was covered. */
  framesWithMasks: number;
  /** Largest number of faces/plates found in one sampled frame. */
  maxObjects: number;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VideoCleanError('cancelled', 'cancelled');
}

/**
 * Builds a new video in which faces and/or plates are covered on every frame.
 * Pass 1 samples frames and runs the detectors; pass 2 re-encodes the picture (H.264) with solid masks,
 * copying the sound as it is. The result holds only picture and sound and is re-checked like any other output.
 * Throws VideoCleanError('cannotMask') when this device cannot decode or encode the video.
 */
export async function cleanVideoWithMasks(file: Blob, detector: Detector, opts: MaskedVideoOptions): Promise<MaskedVideoResult> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    try {
      await assertSaneMovie(sourceFromBlob(file));
    } catch (e) {
      throw new VideoCleanError('unsupported', e instanceof Error ? e.message : String(e));
    }
    const track = await input.getPrimaryVideoTrack().catch(() => null);
    if (!track) throw new VideoCleanError('noVideo', 'no video track');
    const W = await track.getDisplayWidth();
    const H = await track.getDisplayHeight();
    if (typeof OffscreenCanvas === 'undefined') throw new VideoCleanError('cannotMask', 'no OffscreenCanvas');
    const canDecode = typeof VideoDecoder !== 'undefined' && (await track.canDecode().catch(() => false));
    const canEncode = typeof VideoEncoder !== 'undefined' && (await canEncodeVideo('avc', { width: W, height: H }).catch(() => false));
    if (!canDecode || !canEncode) throw new VideoCleanError('cannotMask', `decode ${canDecode}, encode ${canEncode}`);

    // Check that the sound can be handled as asked before the long detection pass (fails early).
    const sound = await soundConversion({ mute: opts.mute ?? false, voice: opts.voice ?? false });
    // Pass 1: look for faces and plates in sampled frames (display orientation).
    const start = await track.getFirstTimestamp();
    // The new file starts at 0; frames are shifted by the start of the kept tracks. Pass 1 works on original
    // times, so pass 2 adds this shift back before looking up masks (camcorder .mts/.ts files start late).
    const audio = await input.getPrimaryAudioTrack().catch(() => null);
    const shift = Math.max(0, await input.getFirstTimestamp(audio ? [track, audio] : [track]));
    const end = await track.computeDuration();
    const times = sampleTimes(start, end, SAMPLE_STEP);
    const scale = Math.min(1, DETECT_SIDE / Math.max(W, H));
    const cw = Math.max(2, Math.round(W * scale));
    const ch = Math.max(2, Math.round(H * scale));
    const sink = new CanvasSink(track, { width: cw, height: ch, fit: 'fill', poolSize: 2 });
    const timeline: TimedBoxes[] = [];
    let i = 0;
    let framesWithMasks = 0;
    let maxObjects = 0;
    let lastShown: number | undefined;
    let outlineBytes = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      checkAbort(opts.signal);
      const t = times[i++]!;
      if (!wrapped) continue;
      // Low or variable frame rates give the same frame for several sample times: look at it once.
      const shown = wrapped.timestamp ?? t;
      if (lastShown !== undefined && Math.abs(shown - lastShown) < 1e-4) {
        opts.onProgress?.('detect', i / times.length);
        continue;
      }
      lastShown = shown;
      let found;
      try {
        const frame = wrapped.canvas as HTMLCanvasElement | OffscreenCanvas;
        found =
          opts.faces || opts.plates || opts.people
            ? await detector.detect(frame, cw, ch, { faces: opts.faces, plates: opts.plates, people: opts.people ?? false, quick: true })
            : [];
        // Outline people so their covers follow the body; in a crowd plain boxes are used (much faster).
        if (opts.people && outlineBytes < MAX_OUTLINE_BYTES && found.filter((d) => d.kind === 'person').length <= MAX_OUTLINED_PEOPLE) {
          await detector.outlinePeople(frame, found).catch((e: unknown) => console.warn('people outlines unavailable', e));
        }
        if (opts.text) found = found.concat(await detector.detectText(frame, cw, ch, undefined, true));
      } catch (e) {
        throw new VideoCleanError('cannotMask', `detection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Smart-style colours are sampled once here, from the detection frame, not on every output frame.
      const fctx = (wrapped.canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      const colors = fctx && (opts.style ?? 'smart') === 'smart' ? sampleColors(fctx, found, 1, cw, ch) : [];
      const boxes = found.map((d, k) => {
        const b: TimedBoxes['boxes'][number] = { x: d.x / scale, y: d.y / scale, w: d.w / scale, h: d.h / scale, shape: d.kind === 'face' ? 'ellipse' : d.silhouette && outlineBytes < MAX_OUTLINE_BYTES ? 'silhouette' : 'rounded' };
        if (d.silhouette) {
          // Kept at a lower resolution for the whole video (memory); a cell is kept if any part of it was set.
          b.silhouette = shrinkOutline(d.silhouette, VIDEO_OUTLINE_CELLS);
          outlineBytes += b.silhouette.data.length;
        }
        if (colors[k]) b.color = colors[k];
        return b;
      });
      if (boxes.length) framesWithMasks++;
      maxObjects = Math.max(maxObjects, boxes.length);
      timeline.push({ t: shown, boxes });
      opts.onProgress?.('detect', i / times.length);
    }
    timeline.sort((a, b) => a.t - b.t);

    // Pass 2: re-encode with masks painted on every frame.
    checkAbort(opts.signal);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new VideoCleanError('cannotMask', 'no drawing surface');
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      tags: {},
      showWarnings: false,
      ...sound,
      trim: { start: shift },
      video: {
        codec: 'avc',
        // The new video is built in memory: long videos use a lower bitrate so phones do not run out.
        quality: end - start > LONG_VIDEO_SECONDS ? QUALITY_MEDIUM : QUALITY_HIGH,
        forceTranscode: true,
        // Bake the rotation into the pixels, so masks (found on upright frames) land in the right place.
        allowTransformationMetadata: false,
        processedWidth: W,
        processedHeight: H,
        process: (sample: VideoSample) => {
          const sw = sample.displayWidth;
          const sh = sample.displayHeight;
          if (canvas.width !== sw || canvas.height !== sh) {
            canvas.width = sw;
            canvas.height = sh;
          }
          sample.draw(ctx, 0, 0, sw, sh);
          const fx = sw / W;
          paintCovers(ctx, masksAt(timeline, sample.timestamp + shift, W, H), opts.style ?? 'smart', fx, sw, sh);
          return canvas;
        },
      },
    });
    checkAbort(opts.signal);
    if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.isVideoTrack())) {
      throw new VideoCleanError('cannotMask', 'conversion not possible');
    }
    conversion.onProgress = (p) => opts.onProgress?.('encode', Math.max(0, Math.min(1, p)));
    const onAbort = () => void conversion.cancel().catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort);
    try {
      await conversion.execute();
    } catch (e) {
      if (opts.signal?.aborted) throw new VideoCleanError('cancelled', 'cancelled');
      throw new VideoCleanError('cannotMask', e instanceof Error ? e.message : String(e));
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const buffer = target.buffer;
    if (!buffer) throw new VideoCleanError('failed', 'no output');
    const bytes = await finishVideo(new Uint8Array(buffer));
    const before = await inspectVideo(sourceFromBlob(file));
    return {
      bytes,
      droppedTracks: Math.max(0, before.tracks.length - conversion.utilizedTracks.length),
      audioKept: conversion.utilizedTracks.some((t) => t.isAudioTrack()),
      framesWithMasks,
      maxObjects,
    };
  } finally {
    input.dispose();
  }
}
