import { inspectVideo } from '../lib/bmff';
import { sourceFromBlob } from '../lib/bytes';
import { ImageCleanError, chooseOutputType, decodeImage, renderClean, type DecodedImage, type OutputType } from '../lib/clean-image';
import { VideoCleanError } from '../lib/video-errors';
import type { Detector } from '../lib/detect/detector';
import type { Detection, Rect } from '../lib/detect/geometry';
import type { Finding } from '../lib/findings';
import { inspectImage, sniffImage } from '../lib/inspect-image';

export type ItemStatus = 'queued' | 'reading' | 'detecting' | 'cleaning' | 'ready' | 'error';
export type ErrorKind = 'unsupported' | 'tooLarge' | 'leftovers' | 'video' | 'cancelled' | 'generic';

export interface Item {
  id: number;
  file: File;
  media: 'image' | 'video';
  status: ItemStatus;
  progress?: number;
  findings: Finding[];
  partial: boolean;
  decoded?: DecodedImage;
  outputType?: OutputType;
  detections: Detection[];
  /** Indexes into `detections` the user switched off. */
  removed: Set<number>;
  manual: Rect[];
  detectFailed: boolean;
  droppedTracks: number;
  /** Video: what happened to faces and plates. */
  videoMasks?: 'covered' | 'off' | 'unavailable';
  /** Video: largest number of faces/plates seen in one sampled frame. */
  videoObjects?: number;
  /** Cancels a running video job. */
  abort?: AbortController;
  output?: { blob: Blob; name: string; url: string };
  error?: ErrorKind;
}

export interface Options {
  faces: boolean;
  plates: boolean;
  /** Weaken the camera sensor pattern in photos. */
  extra: boolean;
}

let nextId = 1;

export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|3gp|qt)$/i.test(file.name);
}

export function newItem(file: File): Item {
  return {
    id: nextId++,
    file,
    media: isVideoFile(file) ? 'video' : 'image',
    status: 'queued',
    findings: [],
    partial: false,
    detections: [],
    removed: new Set(),
    manual: [],
    detectFailed: false,
    droppedTracks: 0,
  };
}

/** A random, meaningless file name, so the name cannot reveal the original time or device. */
export function randomName(ext: string): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return `img-${Array.from(a, (b) => (b % 36).toString(36)).join('')}.${ext}`;
}

/** The masks that will be painted: auto detections the user kept and enabled, plus hand-drawn ones. */
export function activeMasks(item: Item, opts: Options): Rect[] {
  const auto = item.detections.filter(
    (d, i) => !item.removed.has(i) && ((d.kind === 'face' && opts.faces) || (d.kind === 'plate' && opts.plates)),
  );
  return [...auto, ...item.manual];
}

function errorKind(e: unknown): ErrorKind {
  if (e instanceof ImageCleanError) {
    if (e.reason === 'unsupported') return 'unsupported';
    if (e.reason === 'tooLarge' || e.reason === 'encode') return 'tooLarge';
    return 'leftovers';
  }
  if (e instanceof VideoCleanError) return e.reason === 'leftovers' ? 'leftovers' : e.reason === 'cancelled' ? 'cancelled' : 'video';
  if (e instanceof RangeError) return 'tooLarge';
  return 'generic';
}

function setOutput(item: Item, blob: Blob, ext: string): void {
  if (item.output) URL.revokeObjectURL(item.output.url);
  item.output = { blob, name: randomName(ext), url: URL.createObjectURL(blob) };
}

/** Builds (or rebuilds after editing) the safe copy of an image whose detections are known. */
export async function renderImage(item: Item, opts: Options): Promise<void> {
  if (!item.decoded || !item.outputType) throw new Error('image not decoded');
  const bytes = await renderClean(item.decoded, activeMasks(item, opts), item.outputType, { extra: opts.extra });
  const type = item.outputType;
  const ext = type === 'image/png' ? 'png' : 'jpg';
  // Keep the same random name on re-render so a user does not get confused by changing names.
  const name = item.output?.name;
  setOutput(item, new Blob([bytes as BlobPart], { type }), ext);
  if (name) item.output!.name = name;
}

export async function processItem(item: Item, opts: Options, detector: Detector, update: () => void): Promise<void> {
  const set = (status: ItemStatus, progress?: number) => {
    item.status = status;
    if (progress === undefined) delete item.progress;
    else item.progress = progress;
    update();
  };
  try {
    set('reading');
    if (item.media === 'video') {
      const inspection = await inspectVideo(sourceFromBlob(item.file));
      item.findings = inspection.findings;
      item.partial = inspection.partial;
      // The video code is large, so it is only loaded when a video is added.
      const { cleanVideo } = await import('../lib/clean-video');
      let bytes: Uint8Array | undefined;
      if (opts.faces || opts.plates) {
        const { cleanVideoWithMasks } = await import('../lib/video-mask');
        item.abort = new AbortController();
        try {
          set('detecting', 0);
          const r = await cleanVideoWithMasks(item.file, detector, {
            faces: opts.faces,
            plates: opts.plates,
            signal: item.abort.signal,
            onProgress: (phase, p) => set(phase === 'detect' ? 'detecting' : 'cleaning', p),
          });
          bytes = r.bytes;
          item.droppedTracks = r.droppedTracks;
          item.videoMasks = 'covered';
          item.videoObjects = r.maxObjects;
        } catch (e) {
          if (!(e instanceof VideoCleanError) || e.reason !== 'cannotMask') throw e;
          console.warn('cannot cover faces in this video here:', e.message);
          item.videoMasks = 'unavailable';
        } finally {
          delete item.abort;
        }
      } else {
        item.videoMasks = 'off';
      }
      if (!bytes) {
        set('cleaning', 0);
        const result = await cleanVideo(item.file, (p) => set('cleaning', p));
        bytes = result.bytes;
        item.droppedTracks = result.droppedTracks;
      }
      setOutput(item, new Blob([bytes as BlobPart], { type: 'video/mp4' }), 'mp4');
      item.output!.name = item.output!.name.replace(/^img-/, 'vid-');
    } else {
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const inspection = await inspectImage(bytes);
      item.findings = inspection.findings;
      item.partial = inspection.partial;
      item.outputType = chooseOutputType(bytes);
      if (sniffImage(bytes) === 'unknown' && !item.file.type.startsWith('image/')) {
        throw new ImageCleanError('unsupported', 'not an image');
      }
      item.decoded = await decodeImage(item.file);
      set('detecting', 0);
      try {
        item.detections = await detector.detect(item.decoded.element, item.decoded.width, item.decoded.height, {
          faces: true,
          plates: true,
          onProgress: (p) => set('detecting', p),
        });
      } catch (e) {
        console.error('detection failed', e);
        item.detectFailed = true;
      }
      set('cleaning');
      await renderImage(item, opts);
    }
    set('ready');
  } catch (e) {
    console.error(e);
    item.error = errorKind(e);
    set('error');
  }
}
