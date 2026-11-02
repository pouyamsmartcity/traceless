/**
 * Model descriptions and the pure maths around them (input tensors and output decoding).
 * Kept free of browser APIs so it can be unit-tested in Node.
 */

export type ModelId = 'face' | 'plate' | 'text' | 'person' | 'seg';

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

/** bgr255: BGR 0..255. rgb01: RGB 0..1. bgrImagenet/rgbImagenet: 0..1, then ImageNet mean/std. */
export type PixelFormat = 'bgr255' | 'rgb01' | 'bgrImagenet' | 'rgbImagenet';

/** PaddleOCR detection: pixels above this probability are text; a region needs this mean probability. */
export const TEXT_PIXEL_THRESHOLD = 0.2;
export const TEXT_BOX_THRESHOLD = 0.5;

export const MODELS: Record<ModelId, ModelSpec> = {
  // YuNet (OpenCV Zoo, MIT). Fixed 640x640 input, BGR 0..255.
  face: { id: 'face', file: 'models/face-yunet-2023mar.onnx', inputName: 'input', size: 640, pad: 0, pixels: 'bgr255', threshold: 0.5 },
  // YOLOv9-t licence plate detector (open-image-models, MIT). 640x640 input, RGB 0..1, NMS built in.
  plate: { id: 'plate', file: 'models/plate-yolov9t-640.onnx', inputName: 'images', size: 640, pad: 114, pixels: 'rgb01', threshold: 0.3 },
  // YOLOX-s (Megvii, Apache-2.0), COCO classes; we use "person". 640x640 input, BGR 0..255. Weights stored as
  // float16 (scripts/half_weights.py), computed in float32. Far better than YOLOX-nano on small, partly hidden people.
  person: { id: 'person', file: 'models/person-yolox-s.onnx', inputName: 'images', size: 640, pad: 114, pixels: 'bgr255', threshold: 0.35 },
  // U-2-Net small (Apache-2.0): outlines the main subject of a crop; used to draw a person's silhouette.
  seg: { id: 'seg', file: 'models/person-seg-u2netp.onnx', inputName: 'input.1', size: 320, pad: 0, pixels: 'rgbImagenet', threshold: 0.43 },
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
  if (pixels === 'bgrImagenet' || pixels === 'rgbImagenet') {
    // PaddleOCR reads images as BGR and normalises channel 0 (blue) with the first mean/std values.
    const [c0, c2] = pixels === 'bgrImagenet' ? [2, 0] : [0, 2];
    for (let i = 0; i < n; i++) {
      out[i] = (rgba[i * 4 + c0]! / 255 - MEAN[0]!) / STD[0]!;
      out[n + i] = (rgba[i * 4 + 1]! / 255 - MEAN[1]!) / STD[1]!;
      out[2 * n + i] = (rgba[i * 4 + c2]! / 255 - MEAN[2]!) / STD[2]!;
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

/**
 * Turns a segmentation map (size x size, any range) into a low-resolution silhouette (out x out, 1 = person),
 * normalised like the reference implementation (min-max), thresholded, and grown by one cell for a safe edge.
 * Returns undefined when the outline is too small to trust (the caller then covers the whole box).
 */
export function silhouetteFromMap(map: Float32Array, size: number, out: number, threshold: number): Uint8Array | undefined {
  if (map.length !== size * size) throw new Error('unexpected map size');
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of map) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1;
  const cells = new Uint8Array(out * out);
  const f = size / out;
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      // A cell is part of the person if any of its pixels is (safer than averaging).
      let on = 0;
      for (let yy = Math.floor(y * f); yy < Math.floor((y + 1) * f) && !on; yy++) {
        for (let xx = Math.floor(x * f); xx < Math.floor((x + 1) * f); xx++) {
          if ((map[yy * size + xx]! - lo) / range > threshold) {
            on = 1;
            break;
          }
        }
      }
      cells[y * out + x] = on;
    }
  }
  const grown = new Uint8Array(out * out);
  let count = 0;
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && yy < out && xx >= 0 && xx < out && cells[yy * out + xx]) {
          on = 1;
          break;
        }
      }
      grown[y * out + x] = on;
      count += on;
    }
  }
  return count / (out * out) < 0.12 ? undefined : grown;
}
