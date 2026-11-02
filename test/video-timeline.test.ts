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
});
