import { describe, expect, it } from 'vitest';
import { mergeDetections, planPasses } from '../src/lib/detect/detector';
import { expand, iou, letterbox, nms, tiles, unletterbox } from '../src/lib/detect/geometry';
import { decodePlates, decodeYunet, toTensor } from '../src/lib/detect/models';

describe('geometry', () => {
  it('tiles cover the whole image', () => {
    for (const [w, h] of [[2048, 1536], [700, 3000], [513, 512], [100, 100]] as const) {
      const ts = tiles(w, h, 512, 0.25);
      for (let y = 0; y < h; y += 37) for (let x = 0; x < w; x += 41) {
        expect(ts.some((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h)).toBe(true);
      }
      for (const t of ts) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w).toBeLessThanOrEqual(w);
        expect(t.y + t.h).toBeLessThanOrEqual(h);
      }
    }
  });

  it('letterbox round-trips coordinates', () => {
    const region = { x: 100, y: 50, w: 1000, h: 500 };
    const lb = letterbox(region, 640);
    expect(lb.scale).toBeCloseTo(0.64);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(160);
    const r = unletterbox({ x1: 64, y1: 160 + 32, x2: 128, y2: 160 + 64 }, lb);
    expect(r.x).toBeCloseTo(200);
    expect(r.y).toBeCloseTo(100);
    expect(r.w).toBeCloseTo(100);
    expect(r.h).toBeCloseTo(50);
  });

  it('nms keeps the best of overlapping boxes and drops boxes inside others', () => {
    const boxes = [
      { x: 0, y: 0, w: 10, h: 10, score: 0.9 },
      { x: 1, y: 1, w: 10, h: 10, score: 0.8 },
      { x: 2, y: 2, w: 4, h: 4, score: 0.7 },
      { x: 50, y: 50, w: 10, h: 10, score: 0.6 },
    ];
    expect(nms(boxes, 0.3).map((b) => b.score)).toEqual([0.9, 0.6]);
    expect(iou(boxes[0]!, boxes[3]!)).toBe(0);
  });

  it('expand stays inside the image', () => {
    const r = expand({ x: 0, y: 0, w: 10, h: 10 }, 0.5, 0.5, 12, 12);
    expect(r).toEqual({ x: 0, y: 0, w: 12, h: 12 });
  });
});

describe('models', () => {
  it('builds BGR and RGB tensors', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const bgr = toTensor(rgba, 2, 'bgr255');
    expect(Array.from(bgr.subarray(0, 4))).toEqual([30, 60, 90, 120]);
    expect(Array.from(bgr.subarray(8, 12))).toEqual([10, 40, 70, 100]);
    const rgb = toTensor(rgba, 2, 'rgb01');
    expect(rgb[0]).toBeCloseTo(10 / 255);
    expect(rgb[8]).toBeCloseTo(30 / 255);
  });

  it('decodes a YuNet anchor into a box', () => {
    const size = 640;
    const out: Record<string, Float32Array> = {};
    for (const s of [8, 16, 32]) {
      const n = (size / s) ** 2;
      out[`cls_${s}`] = new Float32Array(n);
      out[`obj_${s}`] = new Float32Array(n);
      out[`bbox_${s}`] = new Float32Array(n * 4);
      out[`kps_${s}`] = new Float32Array(n * 10);
    }
    // One confident face at stride 16, row 3, col 5, centred in the cell, 32x48 pixels.
    const i = 3 * 40 + 5;
    out.cls_16![i] = 0.9;
    out.obj_16![i] = 0.9;
    out.bbox_16!.set([0.5, 0.5, Math.log(2), Math.log(3)], i * 4);
    const boxes = decodeYunet(out, size, 0.5);
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect(b.score).toBeCloseTo(0.9);
    expect(b.x1).toBeCloseTo(88 - 16);
    expect(b.x2).toBeCloseTo(88 + 16);
    expect(b.y1).toBeCloseTo(56 - 24);
    expect(b.y2).toBeCloseTo(56 + 24);
  });

  it('decodes plate rows and applies the threshold', () => {
    const rows = new Float32Array([0, 10, 20, 110, 60, 0, 0.8, 0, 1, 1, 5, 5, 0, 0.1]);
    expect(decodePlates(rows, 0.3)).toEqual([{ x1: 10, y1: 20, x2: 110, y2: 60, score: expect.closeTo(0.8) }]);
  });
});

describe('detector planning', () => {
  it('uses tiles only for large pictures', () => {
    expect(planPasses(600, 400, { faces: true, plates: true })).toHaveLength(2);
    const big = planPasses(4000, 3000, { faces: true, plates: true });
    expect(big.filter((p) => p.model === 'face').length).toBeGreaterThan(10);
    expect(big.filter((p) => p.model === 'plate').length).toBeLessThanOrEqual(5);
    expect(planPasses(4000, 3000, { faces: false, plates: false })).toHaveLength(0);
  });

  it('merges duplicates from tiles and grows masks', () => {
    const merged = mergeDetections(
      [
        { model: 'face', box: { x: 100, y: 100, w: 50, h: 50 }, score: 0.9 },
        { model: 'face', box: { x: 102, y: 101, w: 48, h: 50 }, score: 0.7 },
        { model: 'plate', box: { x: 300, y: 300, w: 100, h: 25 }, score: 0.6 },
      ],
      1000,
      1000,
    );
    expect(merged.map((m) => m.kind)).toEqual(['face', 'plate']);
    expect(merged[0]!.w).toBeGreaterThan(50);
    expect(merged[0]!.x).toBeLessThan(100);
  });
});
