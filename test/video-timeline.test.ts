import { describe, expect, it } from 'vitest';
import { coverage, expand } from '../src/lib/detect/geometry';
import { coverContains, type Cover } from '../src/lib/masks';
import { buildTracks, masksAt, matchBoxes, sampleTimes, type TimedBoxes } from '../src/lib/video-timeline';

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
      expect(m[0]!.w).toBeLessThan(50 * 1.8);
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

describe('covers stay on through irregular motion (independent review cases)', () => {
  type R = { x: number; y: number; w: number; h: number };
  const S = 1 / 3;
  /** Every point of the face (5 x 5 grid) lies inside the real shape of some cover (oval, outline or box). */
  const inside = (target: R, covers: Cover[]) => {
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const x = target.x + (target.w * i) / 4;
        const y = target.y + (target.h * j) / 4;
        if (x < 0 || y < 0 || x > 1920 || y > 1080) continue; // outside the picture: nothing to cover
        const hit = covers.some((c) => {
          if (c.shape === 'silhouette' && c.silhouette) {
            const s = c.silhouette;
            const u = Math.floor(((x - c.x) / c.w) * s.w);
            const v = Math.floor(((y - c.y) / c.h) * s.h);
            return u >= 0 && v >= 0 && u < s.w && v < s.h && s.data[v * s.w + u] === 1;
          }
          return coverContains(c, x, y);
        });
        if (!hit) return false;
      }
    }
    return true;
  };
  /** Faces as the detector reports them (the face box grown a little), sampled every 1/3 s. */
  function uncovered(face: (t: number) => R, dur: number, seen: (k: number) => boolean = () => true, until = dur): string[] {
    const samples: TimedBoxes[] = [];
    for (let k = 0; k * S <= dur + 1e-9; k++) {
      // Like the detector: the face box grown, not cut at the picture's edge.
      samples.push({ t: k * S, boxes: seen(k) ? [{ ...expand(face(k * S), 0.15, 0.2, 1920, 1080, false), shape: 'ellipse' }] : [] });
    }
    const bad: string[] = [];
    for (let t = 0; t <= until; t += 1 / 30) if (!inside(face(t), masksAt(samples, t, 1920, 1080))) bad.push(t.toFixed(2));
    return bad;
  }

  it('handheld walking bob', () => {
    expect(uncovered((t) => ({ x: 500, y: 300 + 15 * Math.sin(2 * Math.PI * 1.8 * t), w: 45, h: 45 }), 4)).toEqual([]);
  });

  it('shake at the sampling rate (invisible to the samples)', () => {
    expect(uncovered((t) => ({ x: 500 + 10 * Math.sin(2 * Math.PI * 3 * t + 0.5), y: 300, w: 45, h: 45 }), 4)).toEqual([]);
  });

  it('a person turning around between samples', () => {
    expect(uncovered((t) => ({ x: 400 + 150 * (t < 1.15 ? t : 2.3 - t), y: 300, w: 60, h: 60 }), 2.5)).toEqual([]);
  });

  it('a moving face lost to motion blur keeps a cover that follows it while it is held', () => {
    // Seen until 1 s, then missed; held for 2.5 sample steps.
    expect(uncovered((t) => ({ x: 100 + 300 * t, y: 300, w: 60, h: 60 }), 2, (k) => k <= 3, 1 + 2.5 * S - 0.01)).toEqual([]);
  });

  it('a moving face stays covered after the last sample, up to the end of the video', () => {
    const face = (t: number) => ({ x: 100 + 400 * t, y: 100, w: 60, h: 60 });
    const samples: TimedBoxes[] = [0, 1, 2, 3].map((k) => ({ t: k * S, boxes: [{ ...expand(face(k * S), 0.15, 0.2, 1e9, 1e9), shape: 'ellipse' as const }] }));
    for (let t = 1; t <= 1.3; t += 0.02) expect(inside(face(t), masksAt(samples, t, 1920, 1080)), `at ${t.toFixed(2)}`).toBe(true);
  });

  it('does not link a face to another face far away after a few missed samples', () => {
    const A = { x: 100, y: 100, w: 50, h: 50, shape: 'ellipse' as const };
    const B = { x: 600, y: 100, w: 50, h: 50, shape: 'ellipse' as const };
    const samples: TimedBoxes[] = [];
    for (let k = 0; k <= 9; k++) samples.push({ t: k * S, boxes: k <= 3 ? [A] : k >= 6 ? [B] : [] });
    expect(buildTracks(samples)).toHaveLength(2);
    // B (there but not yet found) keeps its cover from before it was first seen; A keeps its cover while held.
    for (let t = 4 * S; t <= 6 * S; t += 0.02) expect(inside(B, masksAt(samples, t, 4000, 1000)), `B at ${t.toFixed(2)}`).toBe(true);
    for (let t = 3 * S; t <= 3 * S + 2.5 * S - 0.01; t += 0.02) expect(inside(A, masksAt(samples, t, 4000, 1000)), `A at ${t.toFixed(2)}`).toBe(true);
  });

  it('a face half out of the frame stays covered at the edge', () => {
    expect(uncovered((t) => ({ x: -20 + 3 * t, y: 500, w: 60, h: 60 }), 2).length).toBe(0);
    expect(uncovered((t) => ({ x: 1890 - 3 * t, y: -25, w: 60, h: 60 }), 2).length).toBe(0);
  });

  it('repeated frame times (low or variable frame rate) still hold a missed face', () => {
    const F = { x: 100, y: 100, w: 50, h: 50, shape: 'ellipse' as const };
    const samples: TimedBoxes[] = [];
    for (let k = 0; k < 30; k++) samples.push({ t: Math.floor(k / 3), boxes: [] });
    for (let k = 0; k < 6; k++) samples.push({ t: 10 + k * S, boxes: k === 0 ? [F] : [] });
    for (let t = 10; t <= 10 + 2 * S; t += 0.05) expect(inside(F, masksAt(samples, t, 4000, 1000)), `at ${t.toFixed(2)}`).toBe(true);
  });

  describe('person outlines', () => {
    const N = 160;
    // Torso, head and an arm stretched out to the left edge of the box.
    const data = new Uint8Array(N * N);
    for (let y = 40; y < 150; y++) for (let x = 60; x < 100; x++) data[y * N + x] = 1;
    for (let y = 20; y < 30; y++) for (let x = 60; x < 75; x++) data[y * N + x] = 1;
    for (let y = 42; y < 47; y++) for (let x = 0; x < 60; x++) data[y * N + x] = 1;
    const sil = { w: N, h: N, data };
    const person = (x: number) => ({ x, y: 200, w: 200, h: 500, shape: 'silhouette' as const, silhouette: sil });
    /** Cells of the person (at box x) not under the drawn outline. */
    const missed = (bx: number, c: Cover) => {
      let miss = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (!data[y * N + x]) continue;
          if (!inside({ x: bx + ((x + 0.5) / N) * 200, y: 200 + ((y + 0.5) / N) * 500, w: 0, h: 0 }, [c])) miss++;
        }
      }
      return miss;
    };

    it('grows (does not stretch) the outline of a person seen once', () => {
      const samples: TimedBoxes[] = [{ t: 0, boxes: [] }, { t: S, boxes: [person(500)] }, { t: 2 * S, boxes: [] }, { t: 1, boxes: [] }];
      const [c] = masksAt(samples, S, 4000, 4000);
      expect(c!.shape).toBe('silhouette');
      expect(missed(500, c!)).toBe(0);
    });

    it('keeps a running person inside the outline between samples', () => {
      const samples: TimedBoxes[] = [{ t: 0, boxes: [person(500)] }, { t: S, boxes: [person(700)] }, { t: 2 * S, boxes: [person(900)] }];
      for (const tm of [S / 4, S / 2, (3 * S) / 4]) {
        const [c] = masksAt(samples, tm, 4000, 4000);
        expect(missed(500 + 600 * tm, c!), `at ${tm.toFixed(2)}`).toBe(0);
      }
    });
  });
});

describe('outline memory in videos', () => {
  it('shrinks an outline without losing any covered part', async () => {
    const { shrinkOutline } = await import('../src/lib/masks');
    const data = new Uint8Array(160 * 160);
    data[0] = 1;
    data[159 * 160 + 159] = 1;
    data[81 * 160 + 3] = 1;
    const s = shrinkOutline({ w: 160, h: 160, data }, 80);
    expect([s.w, s.h]).toEqual([80, 80]);
    expect(s.data[0]).toBe(1);
    expect(s.data[79 * 80 + 79]).toBe(1);
    expect(s.data[40 * 80 + 1]).toBe(1);
    expect(s.data.reduce((a, b) => a + b, 0)).toBe(3);
  });
});
