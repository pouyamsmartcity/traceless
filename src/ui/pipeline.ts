import { inspectVideo } from '../lib/bmff';
import { sourceFromBlob } from '../lib/bytes';
import { ImageCleanError, chooseOutputType, decodeImage, renderClean, thumbnailDifference, type DecodedImage, type OutputType } from '../lib/clean-image';
import { VideoCleanError } from '../lib/video-errors';
import { DetectionError, type Detector } from '../lib/detect/detector';
import type { Detection, Rect } from '../lib/detect/geometry';
import type { Cover, MaskStyle } from '../lib/masks';
import type { Finding } from '../lib/findings';
import { inspectImage, sniffImage, type Hint } from '../lib/inspect-image';
import { tick, type PhaseClock } from '../lib/eta';

export type ItemStatus = 'queued' | 'reading' | 'detecting' | 'cleaning' | 'ready' | 'error';
export type ErrorKind = 'unsupported' | 'tooLarge' | 'leftovers' | 'video' | 'videoMask' | 'voice' | 'cancelled' | 'generic';

export interface Item {
  id: number;
  file: File;
  media: 'image' | 'video';
  status: ItemStatus;
  progress?: number;
  /** Times the current long step, for the "time left" note. */
  clock?: PhaseClock;
  findings: Finding[];
  /** Signs that the received photo was edited or re-saved (hints, not proof). */
  hints: Hint[];
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
  /** Person detection has run for this photo. */
  peopleDetected?: boolean;
  /** Number of text regions seen by a quick look when text covering is off (for the location warning). */
  textSeen?: number;
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
  /** Video: the options its safe copy was made with. */
  videoMadeWith?: VideoOptions;
  /** Seal code of the original, once it was sealed (safe to note down). */
  sealCode?: string;
  /** Video: the new file has sound. */
  audioKept?: boolean;
  /** Video: the user's choice after a voice change was not possible on this device. */
  soundOverride?: 'mute' | 'keep';
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
  /** Cover whole people (body, clothes, hair). */
  people: boolean;
  /** How covers look: smart colour, black or Pakkon's mark. */
  maskStyle: MaskStyle;
  /** Leave the sound out of videos. */
  mute: boolean;
  /** Change voices in videos. */
  voice: boolean;
}

/** The options a video was made with (shown on its card; a rebuild is offered when they change). */
export interface VideoOptions {
  maskStyle: MaskStyle;
  people: boolean;
  voice: boolean;
  text: boolean;
  faces: boolean;
  plates: boolean;
  mute: boolean;
}

let nextId = 1;

/** Mean grey difference above which a thumbnail shows a different picture (same picture: about 0.02). */
const THUMBNAIL_DIFF = 0.12;

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
    hints: [],
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
  return kind === 'face' ? opts.faces : kind === 'plate' ? opts.plates : kind === 'person' ? opts.people : opts.text;
}

/** Outlines people with the segmentation network; if that fails, they keep box-shaped covers. */
async function outline(detector: Detector, item: Item, detections: Detection[]): Promise<void> {
  if (!item.decoded) return;
  try {
    await detector.outlinePeople(item.decoded.element, detections);
  } catch (e) {
    console.warn('people outlines unavailable, covering their boxes', e);
  }
}

/** Runs person detection once for a photo, when covering whole people is first switched on. */
export async function ensurePeople(item: Item, detector: Detector): Promise<void> {
  if (item.peopleDetected || !item.decoded) return;
  try {
    const people = await detector.detect(item.decoded.element, item.decoded.width, item.decoded.height, { faces: false, plates: false, people: true });
    await outline(detector, item, people);
    item.detections.push(...people);
  } catch (e) {
    console.error('person detection failed', e);
    item.detectFailed = true;
    if (e instanceof DetectionError) item.detections.push(...e.partial);
    item.needsReview = true;
  }
  item.peopleDetected = true;
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

/**
 * When text covering is off, takes a quick look for text anyway, only to warn that signs or writing may
 * reveal the place. Nothing is covered by this look.
 */
export async function lookForText(item: Item, detector: Detector): Promise<void> {
  if (item.textDetected || item.textSeen !== undefined || !item.decoded) return;
  try {
    const found = await detector.detectText(item.decoded.element, item.decoded.width, item.decoded.height, undefined, true);
    item.textSeen = found.length;
  } catch {
    // Unknown, not zero: the card asks the user to look for writing themselves.
    item.textSeen = -1;
  }
}

/** Plain-language reasons why a photo may still reveal where it was taken, after cleaning. */
export function locationRisks(item: Item, opts: Options): ('text' | 'plates' | 'unchecked')[] {
  const risks: ('text' | 'plates' | 'unchecked')[] = [];
  if (!opts.text && item.textSeen === -1) risks.push('unchecked');
  const visible = (kind: 'text' | 'plate') =>
    item.detections.some((d, i) => d.kind === kind && (item.removed.has(i) || !kindEnabled(kind, opts)));
  if (opts.text ? visible('text') : (item.textSeen ?? 0) > 0 || item.detections.some((d) => d.kind === 'text')) risks.push('text');
  if (visible('plate')) risks.push('plates');
  return risks;
}

/** The masks that will be painted: auto detections the user kept and enabled, plus hand-drawn ones. */
export function activeMasks(item: Item, opts: Options): Cover[] {
  const auto = item.detections.filter((d, i) => !item.removed.has(i) && kindEnabled(d.kind, opts)).map(coverOf);
  return [...auto, ...item.manual.map((r): Cover => ({ ...r, shape: 'rounded' }))];
}

/** The shape a detection is covered with. */
export function coverOf(d: Detection): Cover {
  const c: Cover = { x: d.x, y: d.y, w: d.w, h: d.h, shape: d.kind === 'face' ? 'ellipse' : d.kind === 'person' && d.silhouette ? 'silhouette' : 'rounded' };
  if (d.silhouette) c.silhouette = d.silhouette;
  return c;
}

function errorKind(e: unknown): ErrorKind {
  if (e instanceof ImageCleanError) {
    if (e.reason === 'unsupported') return 'unsupported';
    if (e.reason === 'tooLarge' || e.reason === 'encode') return 'tooLarge';
    return 'leftovers';
  }
  if (e instanceof VideoCleanError) {
    if (e.reason === 'cannotMask') return 'videoMask';
    if (e.reason === 'cannotVoice') return 'voice';
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
  const snapshot: Options = { ...opts };
  const bytes = await renderClean(item.decoded, activeMasks(item, opts), item.outputType, { extra: opts.extra, style: opts.maskStyle });
  const type = item.outputType;
  const ext = type === 'image/png' ? 'png' : 'jpg';
  // Keep the same random name on re-render so a user does not get confused by changing names.
  const name = item.output?.name;
  setOutput(item, new Blob([bytes as BlobPart], { type }), ext);
  if (name) item.output!.name = name;
  item.renderedWith = snapshot;
}

/** What a video would be made with now, given the switches and the user's earlier choices for this video. */
export function effectiveVideoOptions(item: Item, o: Options): VideoOptions {
  const covered = !item.skipVideoMasks;
  const mute = item.soundOverride === 'mute' || o.mute;
  const voice = !mute && item.soundOverride !== 'keep' && o.voice;
  return { faces: o.faces && covered, plates: o.plates && covered, text: o.text && covered, people: o.people && covered, mute, voice, maskStyle: o.maskStyle };
}

export function sameVideoOptions(item: Item, b: Options): boolean {
  const a = item.videoMadeWith;
  const e = effectiveVideoOptions(item, b);
  return (
    !!a &&
    a.faces === e.faces &&
    a.plates === e.plates &&
    a.text === e.text &&
    a.people === e.people &&
    a.mute === e.mute &&
    a.voice === e.voice &&
    (a.maskStyle === e.maskStyle || !(a.faces || a.plates || a.text || a.people))
  );
}

/** Switches that change a photo's copy. Sound switches only affect videos. */
const SOUND_SWITCHES = ['mute', 'voice'] as const;
type PhotoSwitch = Exclude<keyof Options, (typeof SOUND_SWITCHES)[number]>;
// Listing every photo switch is enforced by the type: adding a switch to Options without listing it fails to compile.
const PHOTO_SWITCHES = ['faces', 'plates', 'text', 'people', 'extra', 'maskStyle'] as const satisfies readonly PhotoSwitch[];
type Missing = Exclude<PhotoSwitch, (typeof PHOTO_SWITCHES)[number]>;
const allListed: Missing extends never ? true : never = true;
void allListed;

export function sameOptions(a: Options | undefined, b: Options): boolean {
  return !!a && PHOTO_SWITCHES.every((k) => a[k] === b[k]);
}

/** Whether the photo's automatic covering has to be checked by the user before the copy is offered. */
export function coveringRequested(opts: Options): boolean {
  return opts.faces || opts.plates || opts.text || opts.people;
}

export async function processItem(item: Item, liveOpts: Options, detector: Detector, update: () => void): Promise<void> {
  // Use the options as they were when processing started: switches changed meanwhile are handled
  // afterwards (photos are remade, videos offer "make again"), so notes always match the delivered file.
  const opts: Options = { ...liveOpts };
  const set = (status: ItemStatus, progress?: number) => {
    item.status = status;
    if (progress === undefined) {
      delete item.progress;
      delete item.clock;
    } else {
      item.progress = progress;
      item.clock = tick(item.clock, status, progress, Date.now());
    }
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
      const mute = item.soundOverride === 'mute' || opts.mute;
      const voice = !mute && item.soundOverride !== 'keep' && opts.voice;
      if ((opts.faces || opts.plates || opts.text || opts.people) && !item.skipVideoMasks) {
        const { cleanVideoWithMasks } = await import('../lib/video-mask');
        item.abort = new AbortController();
        try {
          set('detecting', 0);
          const r = await cleanVideoWithMasks(item.file, detector, {
            faces: opts.faces,
            plates: opts.plates,
            text: opts.text,
            people: opts.people,
            style: opts.maskStyle,
            mute,
            voice,
            signal: item.abort.signal,
            onProgress: (phase, p) => set(phase === 'detect' ? 'detecting' : 'cleaning', p),
          });
          bytes = r.bytes;
          item.droppedTracks = r.droppedTracks;
          item.audioKept = r.audioKept;
          item.videoMasks = 'covered';
          item.videoObjects = r.maxObjects;
        } catch (e) {
          // Covering (or a voice change) was asked for but could not be done: deliver nothing until the user decides.
          throw e;
        } finally {
          delete item.abort;
        }
      } else {
        item.videoMasks = item.skipVideoMasks ? 'unavailable' : 'off';
      }
      if (!bytes) {
        set('cleaning', 0);
        const result = await cleanVideo(item.file, (p) => set('cleaning', p), { mute, voice });
        bytes = result.bytes;
        item.droppedTracks = result.droppedTracks;
        item.audioKept = result.audioKept;
      }
      item.videoMadeWith = effectiveVideoOptions(item, opts);
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
      item.hints = inspection.hints;
      if (inspection.thumbnail) {
        const diff = await thumbnailDifference(inspection.thumbnail, item.decoded, inspection.orientation);
        if (diff !== undefined && diff > THUMBNAIL_DIFF) item.hints.push({ id: 'thumbnailDiffers' });
      }
      set('detecting', 0);
      try {
        item.detections = await detector.detect(item.decoded.element, item.decoded.width, item.decoded.height, {
          faces: true,
          plates: true,
          people: opts.people,
          onProgress: (p) => set('detecting', p),
        });
        item.peopleDetected = opts.people;
        if (opts.people) await outline(detector, item, item.detections);
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
