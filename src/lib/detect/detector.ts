import { expand, letterbox, nms, tiles, unletterbox, type Detection, type Letterbox, type Rect } from './geometry';
import { MODELS, toTensor, type ModelId, type RawBox } from './models';
import type { WorkerRequest, WorkerResponse } from './worker';

/** Longest side (pixels) of the picture the detectors look at. Larger photos are scaled down for detection only. */
const DETECT_MAX_SIDE = 2048;
/** Tile sides at detection scale: small tiles help to find small, far-away faces in crowds. */
const FACE_TILE = 640;
const PLATE_TILE = 1152;
/** First run includes loading the runtime and models; later runs take well under a second. */
const INFER_TIMEOUT_MS = 120_000;

export interface DetectOptions {
  faces: boolean;
  plates: boolean;
  onProgress?: (fraction: number) => void;
}

type Pass = { model: ModelId; region: Rect };

/** Plans which regions of a w x h image each model looks at. Exported for tests. */
export function planPasses(w: number, h: number, opts: { faces: boolean; plates: boolean }): Pass[] {
  const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(w, h));
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
  return passes;
}

/** Merges raw detections from all passes into final mask boxes in source pixels. */
export function mergeDetections(found: { model: ModelId; box: Rect; score: number }[], w: number, h: number): Detection[] {
  const result: Detection[] = [];
  for (const model of ['face', 'plate'] as const) {
    const mine = found.filter((f) => f.model === model && f.box.w > 1 && f.box.h > 1).map((f) => ({ ...f.box, score: f.score }));
    for (const b of nms(mine, 0.3)) {
      // Grow masks a little: faces to cover hair and ears, plates to cover the frame and country strip.
      const grown = model === 'face' ? expand(b, 0.15, 0.2, w, h) : expand(b, 0.12, 0.2, w, h);
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

  private async infer(model: ModelId, tensor: Float32Array): Promise<RawBox[]> {
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
      this.worker!.postMessage({ type: 'run', id, model, tensor } satisfies WorkerRequest, [tensor.buffer]);
    });
  }

  /** Loads the runtime and models ahead of time, so the first photo is fast. Errors are ignored here. */
  warmUp(): void {
    this.start().catch(() => undefined);
  }

  /** `srcScale` maps source-image pixels to pixels of `source` (which may be a pre-shrunk copy). */
  private prepare(source: CanvasImageSource, srcScale: number, lb: Letterbox, pad: number, pixels: 'bgr255' | 'rgb01'): Float32Array {
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
    try {
      for (const pass of passes) {
        const spec = MODELS[pass.model];
        const lb = letterbox(pass.region, spec.size);
        const tensor = this.prepare(work, shrunk ? scale : 1, lb, spec.pad, spec.pixels);
        const boxes = await this.infer(pass.model, tensor);
        for (const b of boxes) found.push({ model: pass.model, box: unletterbox(b, lb), score: b.score });
        opts.onProgress?.(++done / passes.length);
      }
    } finally {
      if (shrunk) {
        shrunk.width = 0;
        shrunk.height = 0;
      }
    }
    return mergeDetections(found, w, h);
  }
}
