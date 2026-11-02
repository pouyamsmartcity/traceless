import { expand, letterbox, nms, tiles, unletterbox, type Detection, type Letterbox, type Rect } from './geometry';
import { MODELS, toTensor, toTensorWH, type ModelId, type PixelFormat, type RawBox } from './models';
import type { WorkerRequest, WorkerResponse } from './worker';

/** Longest side (pixels) of the picture the detectors look at. Larger photos are scaled down for detection only. */
const DETECT_MAX_SIDE = 2048;
/** Tile sides at detection scale: small tiles help to find small, far-away faces in crowds. */
const FACE_TILE = 640;
const PLATE_TILE = 1152;
/** First run includes loading the runtime and models; later runs take well under a second. */
const INFER_TIMEOUT_MS = 120_000;

/** Some detection passes failed; `partial` holds what the passes that worked found. */
export class DetectionError extends Error {
  constructor(
    message: string,
    readonly partial: Detection[],
  ) {
    super(message);
    this.name = 'DetectionError';
  }
}

export interface DetectOptions {
  faces: boolean;
  plates: boolean;
  /** Whole people (body, clothes, hair). */
  people?: boolean;
  /** Fewer passes, for video frames: one look at the whole frame, plus face tiles for large frames. */
  quick?: boolean;
  onProgress?: (fraction: number) => void;
}

type Pass = { model: ModelId; region: Rect };

/** Plans which regions of a w x h image each model looks at. Exported for tests. */
export function planPasses(w: number, h: number, opts: { faces: boolean; plates: boolean; people?: boolean; quick?: boolean }): Pass[] {
  const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(w, h));
  if (opts.quick) {
    const full: Rect = { x: 0, y: 0, w, h };
    const passes: Pass[] = [];
    if (opts.faces) {
      passes.push({ model: 'face', region: full });
      if (Math.max(w, h) * scale > 1.5 * MODELS.face.size) {
        for (const t of tiles(w * scale, h * scale, 1.5 * MODELS.face.size, 0.2)) {
          passes.push({ model: 'face', region: { x: t.x / scale, y: t.y / scale, w: t.w / scale, h: t.h / scale } });
        }
      }
    }
    if (opts.plates) passes.push({ model: 'plate', region: full });
    if (opts.people) passes.push({ model: 'person', region: full });
    return passes;
  }
  const dw = w * scale;
  const dh = h * scale;
  const full: Rect = { x: 0, y: 0, w, h };
  const toSource = (r: Rect): Rect => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale });
  const passes: Pass[] = [];
  if (opts.faces) {
    passes.push({ model: 'face', region: full });
    if (Math.max(dw, dh) > MODELS.face.size) {
      for (const t of tiles(dw, dh, FACE_TILE, 0.25)) passes.push({ model: 'face', region: toSource(t) });
    }
  }
  if (opts.plates) {
    passes.push({ model: 'plate', region: full });
    if (Math.max(dw, dh) > 1.25 * PLATE_TILE) {
      for (const t of tiles(dw, dh, PLATE_TILE, 0.15)) passes.push({ model: 'plate', region: toSource(t) });
    }
  }
  if (opts.people) {
    passes.push({ model: 'person', region: full });
    // People far away are small: look at parts of a large photo as well (with overlap, so nobody is cut).
    if (Math.max(dw, dh) > 1.25 * PLATE_TILE) {
      for (const t of tiles(dw, dh, PLATE_TILE, 0.3)) passes.push({ model: 'person', region: toSource(t) });
    }
  }
  return passes;
}

/** Merges raw detections from all passes into final mask boxes in source pixels. */
export function mergeDetections(found: { model: ModelId; box: Rect; score: number }[], w: number, h: number): Detection[] {
  const result: Detection[] = [];
  for (const model of ['face', 'plate', 'person'] as const) {
    const mine = found.filter((f) => f.model === model && f.box.w > 1 && f.box.h > 1).map((f) => ({ ...f.box, score: f.score }));
    // Overlapping people in a crowd are distinct: merge person boxes less eagerly.
    for (const b of model === 'person' ? nms(mine, 0.6) : nms(mine, 0.3)) {
      // Grow masks a little: faces to cover hair and ears, plates to cover the frame, people their outline.
      const grown = model === 'face' ? expand(b, 0.15, 0.2, w, h) : model === 'plate' ? expand(b, 0.12, 0.2, w, h) : expand(b, 0.06, 0.04, w, h);
      result.push({ ...grown, score: b.score, kind: model });
    }
  }
  return result;
}

export class Detector {
  private worker: Worker | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (b: RawBox[]) => void; reject: (e: Error) => void }>();
  private canvas: HTMLCanvasElement | undefined;

  constructor(private readonly base: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (m.type === 'ready') resolve();
        else if (m.type === 'result') this.settle(m.id, m.boxes);
        else this.settle(m.id, new Error(m.message));
      };
      w.onerror = (e) => {
        const err = new Error(e.message || 'detector worker failed');
        reject(err);
        this.reset();
      };
      w.postMessage({ type: 'init', base: this.base } satisfies WorkerRequest);
    });
    return this.ready;
  }

  private reset(): void {
    const err = new Error('detector restarted');
    for (const id of [...this.pending.keys()]) this.settle(id, err);
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
  }

  private settle(id: number | undefined, value: RawBox[] | Error): void {
    if (id === undefined) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (value instanceof Error) p.reject(value);
    else p.resolve(value);
  }

  private async infer(model: ModelId, tensor: Float32Array, width: number, height: number): Promise<RawBox[]> {
    await this.start();
    const id = this.nextId++;
    return new Promise<RawBox[]>((resolve, reject) => {
      // Never hang: if the model does not answer in time, give up (the photo is still cleaned,
      // and the user is told to cover things by hand) and start a fresh worker next time.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('detector timed out'));
        this.reset();
      }, INFER_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.worker!.postMessage({ type: 'run', id, model, tensor, width, height } satisfies WorkerRequest, [tensor.buffer]);
    });
  }

  /** Loads the runtime and models ahead of time, so the first photo is fast. Errors are ignored here. */
  warmUp(): void {
    this.start().catch(() => undefined);
  }

  /** `srcScale` maps source-image pixels to pixels of `source` (which may be a pre-shrunk copy). */
  private prepare(source: CanvasImageSource, srcScale: number, lb: Letterbox, pad: number, pixels: PixelFormat, mirror = false): Float32Array {
    const size = lb.size;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = size;
      this.canvas.height = size;
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas unavailable');
    ctx.fillStyle = `rgb(${pad},${pad},${pad})`;
    ctx.fillRect(0, 0, size, size);
    const r = lb.region;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Mirrored: the same picture flipped left-right (the model finds some turned faces only this way).
    ctx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? size : 0, 0);
    ctx.drawImage(
      source,
      r.x * srcScale,
      r.y * srcScale,
      r.w * srcScale,
      r.h * srcScale,
      lb.padX,
      lb.padY,
      Math.round(r.w * lb.scale),
      Math.round(r.h * lb.scale),
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return toTensor(ctx.getImageData(0, 0, size, size).data, size, pixels);
  }

  /** Finds faces and licence plates. Returns mask boxes in source pixels. */
  async detect(source: CanvasImageSource, w: number, h: number, opts: DetectOptions): Promise<Detection[]> {
    const passes = planPasses(w, h, opts);
    if (!passes.length) return [];
    // Shrink a big photo once to detection size, instead of once per pass.
    const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(w, h));
    let work: CanvasImageSource = source;
    let shrunk: HTMLCanvasElement | undefined;
    if (scale < 1) {
      shrunk = document.createElement('canvas');
      shrunk.width = Math.max(1, Math.round(w * scale));
      shrunk.height = Math.max(1, Math.round(h * scale));
      const sctx = shrunk.getContext('2d');
      if (!sctx) throw new Error('canvas unavailable');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(source, 0, 0, shrunk.width, shrunk.height);
      work = shrunk;
    }
    const found: { model: ModelId; box: Rect; score: number }[] = [];
    let done = 0;
    let failure: unknown;
    try {
      for (const pass of passes) {
        const spec = MODELS[pass.model];
        const lb = letterbox(pass.region, spec.size);
        try {
          const tensor = this.prepare(work, shrunk ? scale : 1, lb, spec.pad, spec.pixels);
          const boxes = await this.infer(pass.model, tensor, spec.size, spec.size);
          for (const b of boxes) found.push({ model: pass.model, box: unletterbox(b, lb), score: b.score });
          // Photos: faces are also looked for in the mirrored picture (+5% of small faces on our crowd set).
          if (pass.model === 'face' && !opts.quick) {
            const mirrored = this.prepare(work, shrunk ? scale : 1, lb, spec.pad, spec.pixels, true);
            for (const b of await this.infer('face', mirrored, spec.size, spec.size)) {
              const unflipped = { x1: spec.size - b.x2, x2: spec.size - b.x1, y1: b.y1, y2: b.y2, score: b.score };
              found.push({ model: 'face', box: unletterbox(unflipped, lb), score: b.score });
            }
          }
        } catch (e) {
          failure ??= e;
        }
        opts.onProgress?.(++done / passes.length);
      }
    } finally {
      if (shrunk) {
        shrunk.width = 0;
        shrunk.height = 0;
      }
    }
    const merged = mergeDetections(found, w, h);
    if (failure) throw new DetectionError(failure instanceof Error ? failure.message : String(failure), merged);
    return merged;
  }

  /**
   * Finds text (signs, names, numbers). The picture is enlarged 1.5x (up to 1920 px) because small
   * text is common; very large photos are also scanned in four overlapping parts.
   */
  async detectText(
    source: CanvasImageSource,
    w: number,
    h: number,
    onProgress?: (fraction: number) => void,
    quick = false,
  ): Promise<Detection[]> {
    const passes = planTextPasses(w, h, quick);
    const found: Detection[] = [];
    const canvas = document.createElement('canvas');
    try {
      let done = 0;
      for (const p of passes) {
        canvas.width = p.inW;
        canvas.height = p.inH;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('canvas unavailable');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, p.region.x, p.region.y, p.region.w, p.region.h, 0, 0, p.inW, p.inH);
        const tensor = toTensorWH(ctx.getImageData(0, 0, p.inW, p.inH).data, p.inW, p.inH, MODELS.text.pixels);
        let boxes: RawBox[];
        try {
          boxes = await this.infer('text', tensor, p.inW, p.inH);
        } catch (e) {
          throw new DetectionError(e instanceof Error ? e.message : String(e), nms(found, 0.5));
        }
        const fx = p.region.w / p.inW;
        const fy = p.region.h / p.inH;
        for (const b of boxes) {
          const r = { x: p.region.x + b.x1 * fx, y: p.region.y + b.y1 * fy, w: (b.x2 - b.x1) * fx, h: (b.y2 - b.y1) * fy };
          const grown = expand(r, 0.05, 0.1, w, h);
          if (grown.w > 1 && grown.h > 1) found.push({ ...grown, score: b.score, kind: 'text' });
        }
        onProgress?.(++done / passes.length);
      }
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    return nms(found, 0.5);
  }
}

/** Longest side of the text model's input. */
const TEXT_MAX_SIDE = 1920;

const round32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

/** Plans the regions the text model looks at, and the input size for each. Exported for tests. */
export function planTextPasses(w: number, h: number, quick = false): { region: Rect; inW: number; inH: number }[] {
  const plan = (region: Rect) => {
    const long = Math.max(region.w, region.h);
    // A quick look (one pass, at most 1280 px) is enough to warn that a picture holds text.
    const target = quick ? Math.min(1280, Math.max(640, long)) : Math.min(TEXT_MAX_SIDE, Math.max(960, 1.5 * long));
    const s = target / long;
    return { region, inW: round32(region.w * s), inH: round32(region.h * s) };
  };
  const passes = [plan({ x: 0, y: 0, w, h })];
  if (!quick && Math.max(w, h) > 2400) {
    const tile = Math.ceil(Math.max(w, h) * 0.55);
    for (const t of tiles(w, h, tile, 0.1)) passes.push(plan(t));
  }
  return passes;
}
