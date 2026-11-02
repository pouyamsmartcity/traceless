import { describe, expect, it } from 'vitest';
import { coverage } from '../src/lib/detect/geometry';
import { masksAt, matchBoxes, sampleTimes, type TimedBoxes } from '../src/lib/video-timeline';

const covered = (target: { x: number; y: number; w: number; h: number }, masks: { x: number; y: number; w: number; h: number }[]) => {
  // Sample points inside the target; all must be inside some mask.
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const p = { x: target.x + (target.w * i) / 4, y: target.y + (target.h * j) / 4 };
    if (!masks.some((m) => p.x >= m.x && p.x <= m.x + m.w && p.y >= m.y && p.y <= m.y + m.h)) return false;
  }
  return true;
};

describe('video timeline', () => {
  it('samples the whole duration including the end', () => {
    expect(sampleTimes(0, 1, 1 / 3)).toEqual([0, 0.333, 0.667, 0.999]);
    expect(sampleTimes(0, 0, 0.5)).toEqual([0]);
  });

  it('follows a face moving steadily between samples', () => {
    // A 60x60 face moving right at 300 px/s, sampled every 1/3 s.
    const at = (t: number) => ({ x: 100 + 300 * t, y: 100, w: 60, h: 60 });
    const samples: TimedBoxes[] = [0, 1 / 3, 2 / 3, 1].map((t) => ({ t, boxes: [at(t)] }));
    for (let t = 0; t <= 1; t += 0.02) {
      expect(covered(at(t), masksAt(samples, t, 1000, 1000))).toBe(true);
    }
  });

  it('keeps covering when one sample missed the face', () => {
    const face = { x: 200, y: 200, w: 50, h: 50 };
    const samples: TimedBoxes[] = [
      { t: 0, boxes: [face] },
      { t: 0.33, boxes: [] },
      { t: 0.66, boxes: [face] },
    ];
    for (const t of [0, 0.1, 0.33, 0.5, 0.66]) expect(covered(face, masksAt(samples, t, 1000, 1000))).toBe(true);
  });

  it('covers before the first and after the last sample', () => {
    const face = { x: 10, y: 10, w: 40, h: 40 };
    const samples: TimedBoxes[] = [{ t: 0.2, boxes: [face] }];
    expect(covered(face, masksAt(samples, 0, 500, 500))).toBe(true);
    expect(covered(face, masksAt(samples, 5, 500, 500))).toBe(true);
  });

  it('stays inside the frame', () => {
    const samples: TimedBoxes[] = [{ t: 0, boxes: [{ x: 480, y: 480, w: 40, h: 40 }] }];
    for (const m of masksAt(samples, 0, 500, 500)) {
      expect(m.x + m.w).toBeLessThanOrEqual(500);
      expect(m.y + m.h).toBeLessThanOrEqual(500);
      expect(coverage(m, { x: 0, y: 0, w: 500, h: 500 })).toBe(1);
    }
  });

  it('matches the same face across samples and not distant ones', () => {
    const a = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 800, y: 0, w: 50, h: 50 }];
    const b = [{ x: 820, y: 5, w: 50, h: 50 }, { x: 30, y: 0, w: 50, h: 50 }];
    const pairs = matchBoxes(a, b);
    expect(pairs).toHaveLength(2);
    expect(pairs.find(([p]) => p.x === 0)?.[1].x).toBe(30);
  });

  it('gives each face one cover, not a pile of covers', () => {
    const at = (t: number, x0: number) => ({ x: x0 + 100 * t, y: 100, w: 50, h: 50, shape: 'ellipse' as const });
    const samples: TimedBoxes[] = [0, 1 / 3, 2 / 3, 1].map((t) => ({ t, boxes: [at(t, 100), at(t, 600)] }));
    for (const t of [0, 0.2, 0.5, 0.9]) {
      const m = masksAt(samples, t, 1000, 1000);
      expect(m).toHaveLength(2);
      expect(m.every((c) => c.shape === 'ellipse')).toBe(true);
      // Tight: a slow face's cover is only a little bigger than the face.
      expect(m[0]!.w).toBeLessThan(50 * 1.6);
    }
  });

  it('keeps a fast face covered when two samples in a row miss it', () => {
    const at = (t: number) => ({ x: 100 + 400 * t, y: 300, w: 60, h: 60 });
    const samples: TimedBoxes[] = [
      { t: 0, boxes: [at(0)] },
      { t: 1 / 3, boxes: [at(1 / 3)] },
      { t: 2 / 3, boxes: [] },
      { t: 1, boxes: [] },
      { t: 4 / 3, boxes: [at(4 / 3)] },
      { t: 5 / 3, boxes: [at(5 / 3)] },
    ];
    for (let t = 0; t <= 5 / 3; t += 0.02) {
      expect(covered(at(t), masksAt(samples, t, 2000, 1000)), `at ${t.toFixed(2)}s`).toBe(true);
    }
  });

  it('keeps faces of different shapes in separate tracks', () => {
    const samples: TimedBoxes[] = [
      { t: 0, boxes: [{ x: 100, y: 100, w: 50, h: 50, shape: 'ellipse' }, { x: 110, y: 110, w: 60, h: 20, shape: 'rounded' }] },
      { t: 1 / 3, boxes: [{ x: 105, y: 100, w: 50, h: 50, shape: 'ellipse' }, { x: 112, y: 110, w: 60, h: 20, shape: 'rounded' }] },
    ];
    const m = masksAt(samples, 0.15, 1000, 1000);
    expect(m.map((c) => c.shape).sort()).toEqual(['ellipse', 'rounded']);
  });
});

describe('person outlines in videos', () => {
  const N = 160;
  const outline = (x0: number, x1: number) => {
    const data = new Uint8Array(N * N);
    for (let y = 20; y < 140; y++) for (let x = x0; x < x1; x++) data[y * N + x] = 1;
    return { w: N, h: N, data };
  };

  it('blends the outlines of both neighbouring samples and grows them', async () => {
    const { blendSilhouettes } = await import('../src/lib/video-timeline');
    const s = blendSilhouettes(outline(10, 30), outline(100, 120), 4);
    const on = (x: number, y: number) => s.data[y * N + x] === 1;
    expect(on(20, 80) && on(110, 80)).toBe(true); // both poses
    expect(on(6, 80) && on(123, 80) && on(20, 16)).toBe(true); // grown
    expect(on(60, 80) || on(3, 80) || on(20, 10)).toBe(false); // but not filled in between
  });

  it('keeps one outlined cover per person, falling back to a box without outlines', () => {
    const box = (t: number, sil: boolean): TimedBoxes => ({
      t,
      boxes: [{ x: 100 + t * 30, y: 100, w: 200, h: 500, shape: sil ? 'silhouette' : 'rounded', ...(sil ? { silhouette: outline(40, 120) } : {}) }],
    });
    const samples = [box(0, true), box(1 / 3, true), box(2 / 3, false), box(1, true)];
    const m1 = masksAt(samples, 0.15, 1920, 1080);
    expect(m1).toHaveLength(1);
    expect(m1[0]!.shape).toBe('silhouette');
    expect(m1[0]!.silhouette).toBeDefined();
    const m2 = masksAt(samples, 0.5, 1920, 1080);
    expect(m2).toHaveLength(1);
    expect(m2[0]!.shape).toBe('rounded');
  });

  it('does not squeeze an outline at the frame edge', () => {
    const samples: TimedBoxes[] = [
      { t: 0, boxes: [{ x: -5, y: 100, w: 200, h: 500, shape: 'silhouette', silhouette: outline(0, 160) }] },
      { t: 1 / 3, boxes: [{ x: -5, y: 100, w: 200, h: 500, shape: 'silhouette', silhouette: outline(0, 160) }] },
    ];
    const [c] = masksAt(samples, 0.1, 1920, 1080);
    expect(c!.x).toBeLessThan(-5);
    expect(c!.w).toBeGreaterThan(200);
  });
});
