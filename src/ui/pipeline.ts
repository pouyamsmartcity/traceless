import { inspectVideo } from '../lib/bmff';
import { sourceFromBlob } from '../lib/bytes';
import { ImageCleanError, chooseOutputType, decodeImage, renderClean, type DecodedImage, type OutputType } from '../lib/clean-image';
import { VideoCleanError } from '../lib/video-errors';
import { DetectionError, type Detector } from '../lib/detect/detector';
import type { Detection, Rect } from '../lib/detect/geometry';
import type { Finding } from '../lib/findings';
import { inspectImage, sniffImage } from '../lib/inspect-image';

export type ItemStatus = 'queued' | 'reading' | 'detecting' | 'cleaning' | 'ready' | 'error';
export type ErrorKind = 'unsupported' | 'tooLarge' | 'leftovers' | 'video' | 'videoMask' | 'cancelled' | 'generic';

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
  /** Text detection has run for this photo. */
  textDetected: boolean;
  droppedTracks: number;
  /** Video: what happened to faces and plates. */
  videoMasks?: 'covered' | 'off' | 'unavailable';
  /** Video: largest number of faces/plates seen in one sampled frame. */
  videoObjects?: number;
  /** Cancels a running video job. */
  abort?: AbortController;
  output?: { blob: Blob; name: string; url: string };
  /** The exact options the current safe copy was made with (the summary is built from these). */
  renderedWith?: Options;
  /** Automatic finding failed: the copy is held back until the user covers by hand or confirms. */
  needsReview: boolean;
  /** A re-render is running; `stale` asks for another one when it ends. */
  busy?: boolean;
  stale?: boolean;
  /** The user chose to continue without covering in a video whose covering failed. */
  skipVideoMasks?: boolean;
  error?: ErrorKind;
  /** Technical detail of an error, shown so a user can report it (never contains file contents). */
  errorDetail?: string;
}

export interface Options {
  faces: boolean;
  plates: boolean;
  /** Weaken the camera sensor pattern in photos. */
  extra: boolean;
  /** Cover text in photos (signs, names, numbers). */
  text: boolean;
}

let nextId = 1;

/** The whole new video is built in memory; beyond this size phones run out of memory. */
const MAX_VIDEO_BYTES = 2 * 1024 ** 3;

export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|3gp|qt|mts|m2ts|ts|mkv|webm)$/i.test(file.name);
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
    textDetected: false,
    droppedTracks: 0,
    needsReview: false,
  };
}

/** A random, meaningless file name, so the name cannot reveal the original time or device. */
export function randomName(ext: string): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return `img-${Array.from(a, (b) => (b % 36).toString(36)).join('')}.${ext}`;
}

export function kindEnabled(kind: Detection['kind'], opts: Options): boolean {
  return kind === 'face' ? opts.faces : kind === 'plate' ? opts.plates : opts.text;
}

/** Runs text detection once for a photo (it is only needed when text covering is switched on). */
export async function ensureText(item: Item, detector: Detector, onProgress?: (f: number) => void): Promise<void> {
  if (item.textDetected || !item.decoded) return;
  try {
    const found = await detector.detectText(item.decoded.element, item.decoded.width, item.decoded.height, onProgress);
    item.detections.push(...found);
  } catch (e) {
    console.error('text detection failed', e);
    item.detectFailed = true;
    if (e instanceof DetectionError) item.detections.push(...e.partial);
    item.needsReview = true;
  }
  item.textDetected = true;
}

/** The masks that will be painted: auto detections the user kept and enabled, plus hand-drawn ones. */
export function activeMasks(item: Item, opts: Options): Rect[] {
  const auto = item.detections.filter(
    (d, i) => !item.removed.has(i) && kindEnabled(d.kind, opts),
  );
  return [...auto, ...item.manual];
}

function errorKind(e: unknown): ErrorKind {
  if (e instanceof ImageCleanError) {
    if (e.reason === 'unsupported') return 'unsupported';
    if (e.reason === 'tooLarge' || e.reason === 'encode') return 'tooLarge';
    return 'leftovers';
  }
  if (e instanceof VideoCleanError) {
    if (e.reason === 'cannotMask') return 'videoMask';
    return e.reason === 'leftovers' ? 'leftovers' : e.reason === 'cancelled' ? 'cancelled' : 'video';
  }
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
  const snapshot: Options = { faces: opts.faces, plates: opts.plates, text: opts.text, extra: opts.extra };
  const bytes = await renderClean(item.decoded, activeMasks(item, opts), item.outputType, { extra: opts.extra });
  const type = item.outputType;
  const ext = type === 'image/png' ? 'png' : 'jpg';
  // Keep the same random name on re-render so a user does not get confused by changing names.
  const name = item.output?.name;
  setOutput(item, new Blob([bytes as BlobPart], { type }), ext);
  if (name) item.output!.name = name;
  item.renderedWith = snapshot;
}

export function sameOptions(a: Options | undefined, b: Options): boolean {
  return !!a && a.faces === b.faces && a.plates === b.plates && a.text === b.text && a.extra === b.extra;
}

/** Whether the photo's automatic covering has to be checked by the user before the copy is offered. */
export function coveringRequested(opts: Options): boolean {
  return opts.faces || opts.plates || opts.text;
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
      if (item.file.size > MAX_VIDEO_BYTES) throw new RangeError('video larger than 2 GB');
      const inspection = await inspectVideo(sourceFromBlob(item.file));
      item.findings = inspection.findings;
      item.partial = inspection.partial;
      // The video code is large, so it is only loaded when a video is added.
      const { cleanVideo } = await import('../lib/clean-video');
      let bytes: Uint8Array | undefined;
      if ((opts.faces || opts.plates) && !item.skipVideoMasks) {
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
          // Covering was asked for but could not be done: deliver nothing until the user decides.
          if (e instanceof VideoCleanError && e.reason === 'cannotMask') throw new VideoCleanError('cannotMask', e.message);
          throw e;
        } finally {
          delete item.abort;
        }
      } else {
        item.videoMasks = item.skipVideoMasks ? 'unavailable' : 'off';
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
        // Keep whatever the passes that did work found.
        if (e instanceof DetectionError) item.detections = e.partial;
      }
      if (opts.text) await ensureText(item, detector, (p) => set('detecting', p));
      set('cleaning');
      await renderImage(item, opts);
      if (item.detectFailed && coveringRequested(opts)) item.needsReview = true;
    }
    set('ready');
  } catch (e) {
    console.error(e);
    item.error = errorKind(e);
    item.errorDetail = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
    set('error');
  }
}
