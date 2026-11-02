/**
 * Model descriptions and the pure maths around them (input tensors and output decoding).
 * Kept free of browser APIs so it can be unit-tested in Node.
 */

export type ModelId = 'face' | 'plate' | 'text' | 'person';

export interface ModelSpec {
  id: ModelId;
  file: string;
  inputName: string;
  size: number;
  /** Grey level used for padding around the letterboxed picture. */
  pad: number;
  /** Channel order and value range the model was trained with. */
  pixels: PixelFormat;
  threshold: number;
}

/** bgr255: BGR 0..255. rgb01: RGB 0..1. bgrImagenet: BGR, 0..1, then ImageNet mean/std (PaddleOCR). */
export type PixelFormat = 'bgr255' | 'rgb01' | 'bgrImagenet';

/** PaddleOCR detection: pixels above this probability are text; a region needs this mean probability. */
export const TEXT_PIXEL_THRESHOLD = 0.2;
export const TEXT_BOX_THRESHOLD = 0.5;

export const MODELS: Record<ModelId, ModelSpec> = {
  // YuNet (OpenCV Zoo, MIT). Fixed 640x640 input, BGR 0..255.
  face: { id: 'face', file: 'models/face-yunet-2023mar.onnx', inputName: 'input', size: 640, pad: 0, pixels: 'bgr255', threshold: 0.5 },
  // YOLOv9-t licence plate detector (open-image-models, MIT). 640x640 input, RGB 0..1, NMS built in.
  plate: { id: 'plate', file: 'models/plate-yolov9t-640.onnx', inputName: 'images', size: 640, pad: 114, pixels: 'rgb01', threshold: 0.3 },
  // YOLOX-nano (Megvii, Apache-2.0), COCO classes; we use "person". 416x416 input, BGR 0..255.
  person: { id: 'person', file: 'models/person-yolox-nano.onnx', inputName: 'images', size: 416, pad: 114, pixels: 'bgr255', threshold: 0.35 },
  // PaddleOCR PP-OCRv3 text detection (Apache-2.0). Any size that is a multiple of 32. Outputs a text probability map.
  text: { id: 'text', file: 'models/text-ppocrv3-det.onnx', inputName: 'x', size: 0, pad: 0, pixels: 'bgrImagenet', threshold: TEXT_BOX_THRESHOLD },
};

/** Converts RGBA pixels of a size x size picture into a planar float tensor (1x3xHxW). */
export function toTensor(rgba: Uint8ClampedArray | Uint8Array, size: number, pixels: PixelFormat): Float32Array {
  return toTensorWH(rgba, size, size, pixels);
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Converts RGBA pixels of a w x h picture into a planar float tensor (1x3xHxW). */
export function toTensorWH(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, pixels: PixelFormat): Float32Array {
  const n = w * h;
  if (rgba.length !== n * 4) throw new Error(`expected ${n * 4} bytes, got ${rgba.length}`);
  const out = new Float32Array(3 * n);
  if (pixels === 'bgrImagenet') {
    // PaddleOCR reads images as BGR and normalises channel 0 (blue) with the first mean/std values.
    for (let i = 0; i < n; i++) {
      out[i] = (rgba[i * 4 + 2]! / 255 - MEAN[0]!) / STD[0]!;
      out[n + i] = (rgba[i * 4 + 1]! / 255 - MEAN[1]!) / STD[1]!;
      out[2 * n + i] = (rgba[i * 4]! / 255 - MEAN[2]!) / STD[2]!;
    }
    return out;
  }
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

/**
 * Decodes YOLOX output rows (per anchor: x, y, log w, log h, objectness, 80 class scores) for one class,
 * into boxes in model pixels. Anchors run over strides 8, 16 and 32.
 */
export function decodeYolox(out: Float32Array, size: number, threshold: number, classIndex = 0): RawBox[] {
  const stride = 85;
  const boxes: RawBox[] = [];
  let i = 0;
  for (const s of [8, 16, 32]) {
    const g = size / s;
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++, i++) {
        const o = i * stride;
        if (o + stride > out.length) throw new Error('unexpected YOLOX output size');
        const score = out[o + 4]! * out[o + 5 + classIndex]!;
        if (!(score >= threshold)) continue;
        const cx = (out[o]! + gx) * s;
        const cy = (out[o + 1]! + gy) * s;
        const w = Math.exp(out[o + 2]!) * s;
        const h = Math.exp(out[o + 3]!) * s;
        if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
        boxes.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score });
      }
    }
  }
  if (i * stride !== out.length) throw new Error('unexpected YOLOX output size');
  return boxes;
}

/**
 * Turns PaddleOCR's text probability map (w x h) into boxes around text regions, in map pixels.
 * Connected regions above the pixel threshold whose mean probability passes the box threshold are kept,
 * then grown like PaddleOCR's "unclip" (distance = area * 1.5 / perimeter) to cover whole letters.
 */
export function decodeTextMap(prob: Float32Array, w: number, h: number, pixelThreshold: number, boxThreshold: number): RawBox[] {
  if (prob.length !== w * h) throw new Error('unexpected text map size');
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes: RawBox[] = [];
  let next = 0;
  for (let start = 0; start < w * h; start++) {
    if (label[start] || !(prob[start]! > pixelThreshold)) continue;
    next++;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    let x1 = w, y1 = h, x2 = -1, y2 = -1, count = 0, sum = 0;
    while (top > 0) {
      const p = stack[--top]!;
      const x = p % w;
      const y = (p - x) / w;
      count++;
      sum += prob[p]!;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
      if (x > 0 && !label[p - 1] && prob[p - 1]! > pixelThreshold) { label[p - 1] = next; stack[top++] = p - 1; }
      if (x < w - 1 && !label[p + 1] && prob[p + 1]! > pixelThreshold) { label[p + 1] = next; stack[top++] = p + 1; }
      if (y > 0 && !label[p - w] && prob[p - w]! > pixelThreshold) { label[p - w] = next; stack[top++] = p - w; }
      if (y < h - 1 && !label[p + w] && prob[p + w]! > pixelThreshold) { label[p + w] = next; stack[top++] = p + w; }
    }
    if (count < 6) continue;
    const score = sum / count;
    if (score < boxThreshold) continue;
    const bw = x2 + 1 - x1;
    const bh = y2 + 1 - y1;
    const d = (bw * bh * 1.5) / (2 * (bw + bh));
    boxes.push({ x1: x1 - d, y1: y1 - d, x2: x2 + 1 + d, y2: y2 + 1 + d, score });
  }
  return boxes;
}
