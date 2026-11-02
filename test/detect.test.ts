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

describe('text detection maths', () => {
  it('finds separate text regions in a probability map and grows them', async () => {
    const { decodeTextMap } = await import('../src/lib/detect/models');
    const w = 40;
    const h = 20;
    const map = new Float32Array(w * h);
    const fill = (x1: number, y1: number, x2: number, y2: number, v: number) => {
      for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) map[y * w + x] = v;
    };
    fill(2, 2, 12, 6, 0.9); // a word
    fill(20, 10, 36, 14, 0.9); // another word
    fill(30, 2, 34, 4, 0.25); // faint blob: above pixel threshold, below box threshold
    map[0] = 0.9; // single noisy pixel
    const boxes = decodeTextMap(map, w, h, 0.2, 0.5);
    expect(boxes).toHaveLength(2);
    const [a, b] = boxes.sort((p, q) => p.x1 - q.x1);
    expect(a!.x1).toBeLessThan(2);
    expect(a!.x2).toBeGreaterThan(12);
    expect(b!.y1).toBeLessThan(10);
    expect(b!.y2).toBeGreaterThan(14);
  });

  it('enlarges small pictures and splits very large ones', async () => {
    const { planTextPasses } = await import('../src/lib/detect/detector');
    const small = planTextPasses(700, 524);
    expect(small).toHaveLength(1);
    expect(small[0]!.inW % 32).toBe(0);
    expect(small[0]!.inW).toBeGreaterThanOrEqual(1024);
    const big = planTextPasses(4000, 3000);
    expect(big).toHaveLength(5);
    for (const p of big) expect(Math.max(p.inW, p.inH)).toBeLessThanOrEqual(1920);
  });
});

describe('YOLOX person decoding', () => {
  it('decodes a confident person anchor and ignores the rest', async () => {
    const { decodeYolox } = await import('../src/lib/detect/models');
    const size = 416;
    const anchors = (size / 8) ** 2 + (size / 16) ** 2 + (size / 32) ** 2;
    const out = new Float32Array(anchors * 85);
    // Anchor at stride 16, row 2, col 3 (index after all stride-8 anchors).
    const i = (size / 8) ** 2 + 2 * (size / 16) + 3;
    out.set([0.5, 0.5, Math.log(4), Math.log(8), 0.9, 0.9], i * 85);
    const boxes = decodeYolox(out, size, 0.35);
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect(b.score).toBeCloseTo(0.81);
    expect((b.x1 + b.x2) / 2).toBeCloseTo((3 + 0.5) * 16);
    expect(b.x2 - b.x1).toBeCloseTo(64);
    expect(b.y2 - b.y1).toBeCloseTo(128);
    expect(() => decodeYolox(new Float32Array(85 * 10), size, 0.35)).toThrow();
  });

  it('plans person passes only when asked', () => {
    expect(planPasses(800, 600, { faces: false, plates: false, people: true }).map((p) => p.model)).toEqual(['person']);
    expect(planPasses(4000, 3000, { faces: false, plates: false, people: true }).length).toBeGreaterThan(1);
  });
});

describe('cover shapes', () => {
  it('a face ellipse contains the whole face box it was made from', async () => {
    const { ellipseOf } = await import('../src/lib/masks');
    const { expand } = await import('../src/lib/detect/geometry');
    const face = { x: 100, y: 100, w: 80, h: 100 };
    const grown = expand(face, 0.15, 0.2, 10_000, 10_000);
    const e = ellipseOf(grown);
    for (const [x, y] of [[face.x, face.y], [face.x + face.w, face.y], [face.x, face.y + face.h], [face.x + face.w, face.y + face.h]]) {
      expect(((x! - e.cx) / e.rx) ** 2 + ((y! - e.cy) / e.ry) ** 2).toBeLessThanOrEqual(1);
    }
  });

  it('turns a segmentation map into a grown silhouette, or nothing when too small', async () => {
    const { silhouetteFromMap } = await import('../src/lib/detect/models');
    const size = 32;
    const map = new Float32Array(size * size);
    for (let y = 8; y < 28; y++) for (let x = 10; x < 22; x++) map[y * size + x] = 1;
    const sil = silhouetteFromMap(map, size, 16, 0.43)!;
    expect(sil).toBeDefined();
    expect(sil[4 * 16 + 5]).toBe(1); // inside
    expect(sil[4 * 16 + 4]).toBe(1); // grown by one cell
    expect(sil[1 * 16 + 1]).toBe(0); // far outside
    const tiny = new Float32Array(size * size);
    tiny[5 * size + 5] = 1;
    expect(silhouetteFromMap(tiny, size, 16, 0.43)).toBeUndefined();
  });
});
