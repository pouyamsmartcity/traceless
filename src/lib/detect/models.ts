/**
 * Model descriptions and the pure maths around them (input tensors and output decoding).
 * Kept free of browser APIs so it can be unit-tested in Node.
 */

export type ModelId = 'face' | 'plate';

export interface ModelSpec {
  id: ModelId;
  file: string;
  inputName: string;
  size: number;
  /** Grey level used for padding around the letterboxed picture. */
  pad: number;
  /** Channel order and value range the model was trained with. */
  pixels: 'bgr255' | 'rgb01';
  threshold: number;
}

export const MODELS: Record<ModelId, ModelSpec> = {
  // YuNet (OpenCV Zoo, MIT). Fixed 640x640 input, BGR 0..255.
  face: { id: 'face', file: 'models/face-yunet-2023mar.onnx', inputName: 'input', size: 640, pad: 0, pixels: 'bgr255', threshold: 0.5 },
  // YOLOv9-t licence plate detector (open-image-models, MIT). 640x640 input, RGB 0..1, NMS built in.
  plate: { id: 'plate', file: 'models/plate-yolov9t-640.onnx', inputName: 'images', size: 640, pad: 114, pixels: 'rgb01', threshold: 0.3 },
};

/** Converts RGBA pixels of a size x size picture into a planar float tensor (1x3xHxW). */
export function toTensor(rgba: Uint8ClampedArray | Uint8Array, size: number, pixels: ModelSpec['pixels']): Float32Array {
  const n = size * size;
  if (rgba.length !== n * 4) throw new Error(`expected ${n * 4} bytes, got ${rgba.length}`);
  const out = new Float32Array(3 * n);
  const bgr = pixels === 'bgr255';
  const k = bgr ? 1 : 1 / 255;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]! * k;
    const g = rgba[i * 4 + 1]! * k;
    const b = rgba[i * 4 + 2]! * k;
    out[i] = bgr ? b : r;
    out[n + i] = g;
    out[2 * n + i] = bgr ? r : b;
  }
  return out;
}

export interface RawBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Decodes YuNet's per-stride outputs (cls_*, obj_*, bbox_*) into boxes in model pixels. */
export function decodeYunet(out: Record<string, Float32Array>, size: number, threshold: number): RawBox[] {
  const boxes: RawBox[] = [];
  for (const s of [8, 16, 32]) {
    const cls = out[`cls_${s}`];
    const obj = out[`obj_${s}`];
    const bbox = out[`bbox_${s}`];
    if (!cls || !obj || !bbox) throw new Error(`missing YuNet output for stride ${s}`);
    const cols = size / s;
    const count = cols * cols;
    if (cls.length !== count || bbox.length !== count * 4) throw new Error('unexpected YuNet output size');
    for (let i = 0; i < count; i++) {
      const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
      if (score < threshold) continue;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const cx = (col + bbox[i * 4]!) * s;
      const cy = (row + bbox[i * 4 + 1]!) * s;
      const w = Math.exp(bbox[i * 4 + 2]!) * s;
      const h = Math.exp(bbox[i * 4 + 3]!) * s;
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      boxes.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score });
    }
  }
  return boxes;
}

/** Decodes the end-to-end YOLO output rows [batch, x1, y1, x2, y2, class, score]. */
export function decodePlates(out: Float32Array, threshold: number): RawBox[] {
  if (out.length % 7 !== 0) throw new Error('unexpected plate output size');
  const boxes: RawBox[] = [];
  for (let i = 0; i < out.length; i += 7) {
    const score = out[i + 6]!;
    if (!(score >= threshold)) continue;
    const b = { x1: out[i + 1]!, y1: out[i + 2]!, x2: out[i + 3]!, y2: out[i + 4]!, score };
    if (b.x2 > b.x1 && b.y2 > b.y1) boxes.push(b);
  }
  return boxes;
}
