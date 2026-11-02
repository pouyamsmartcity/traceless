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
  canEncodeVideo,
  type VideoSample,
} from 'mediabunny';
import { sourceFromBlob } from './bytes';
import { inspectVideo, zeroMovieTimes } from './bmff';
import { videoLeftovers, type CleanVideoResult } from './clean-video';
import type { Detector } from './detect/detector';
import { MASK_COLOR } from './clean-image';
import { masksAt, sampleTimes, type TimedBoxes } from './video-timeline';
import { VideoCleanError } from './video-errors';

/** How often to look for faces, in seconds. Masks between samples are interpolated (see video-timeline). */
const SAMPLE_STEP = 1 / 3;
/** Longest side of the frames the detectors look at. */
const DETECT_SIDE = 1280;

export interface MaskedVideoOptions {
  faces: boolean;
  plates: boolean;
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
    const track = await input.getPrimaryVideoTrack().catch(() => null);
    if (!track) throw new VideoCleanError('noVideo', 'no video track');
    const W = await track.getDisplayWidth();
    const H = await track.getDisplayHeight();
    const canDecode = typeof VideoDecoder !== 'undefined' && (await track.canDecode().catch(() => false));
    const canEncode = typeof VideoEncoder !== 'undefined' && (await canEncodeVideo('avc', { width: W, height: H }).catch(() => false));
    if (!canDecode || !canEncode) throw new VideoCleanError('cannotMask', `decode ${canDecode}, encode ${canEncode}`);

    // Pass 1: look for faces and plates in sampled frames (display orientation).
    const start = await track.getFirstTimestamp();
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
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      checkAbort(opts.signal);
      const t = times[i++]!;
      if (!wrapped) continue;
      const found = await detector.detect(wrapped.canvas as HTMLCanvasElement | OffscreenCanvas, cw, ch, {
        faces: opts.faces,
        plates: opts.plates,
        quick: true,
      });
      const boxes = found.map((d) => ({ x: d.x / scale, y: d.y / scale, w: d.w / scale, h: d.h / scale }));
      if (boxes.length) framesWithMasks++;
      maxObjects = Math.max(maxObjects, boxes.length);
      timeline.push({ t: wrapped.timestamp ?? t, boxes });
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
      video: {
        codec: 'avc',
        quality: QUALITY_HIGH,
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
          const fy = sh / H;
          ctx.fillStyle = MASK_COLOR;
          for (const m of masksAt(timeline, sample.timestamp, W, H)) {
            const x = Math.floor(m.x * fx);
            const y = Math.floor(m.y * fy);
            ctx.fillRect(x, y, Math.ceil((m.x + m.w) * fx) - x, Math.ceil((m.y + m.h) * fy) - y);
          }
          return canvas;
        },
      },
    });
    if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.isVideoTrack())) {
      throw new VideoCleanError('cannotMask', 'conversion not possible');
    }
    conversion.onProgress = (p) => opts.onProgress?.('encode', Math.max(0, Math.min(1, p)));
    const onAbort = () => void conversion.cancel();
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
    const bytes = new Uint8Array(buffer);
    zeroMovieTimes(bytes);
    const leftovers = await videoLeftovers(bytes);
    if (leftovers.length) throw new VideoCleanError('leftovers', leftovers.join('; '));
    const before = await inspectVideo(sourceFromBlob(file));
    return {
      bytes,
      droppedTracks: Math.max(0, before.tracks.length - conversion.utilizedTracks.length),
      framesWithMasks,
      maxObjects,
    };
  } finally {
    input.dispose();
  }
}
