import { describe, expect, it } from 'vitest';
import { cropArea } from '../src/lib/clean-image';
import { clampTrim } from '../src/lib/clean-video';

describe('crop and trim limits', () => {
  it('keeps a crop inside the picture, at least 8 x 8, and ignores a crop of everything', () => {
    expect(cropArea(undefined, 100, 100)).toBeUndefined();
    expect(cropArea({ x: 0, y: 0, w: 100, h: 100 }, 100, 100)).toBeUndefined();
    expect(cropArea({ x: -20, y: 10, w: 50, h: 500 }, 100, 100)).toEqual({ x: 0, y: 10, w: 50, h: 90 });
    expect(cropArea({ x: 99, y: 99, w: 1, h: 1 }, 100, 100)).toEqual({ x: 92, y: 92, w: 8, h: 8 });
  });

  it('keeps a trim inside the video and refuses one shorter than half a second', () => {
    expect(clampTrim(undefined, 10)).toBeUndefined();
    expect(clampTrim({ start: 0, end: 10 }, 10)).toBeUndefined();
    expect(clampTrim({ start: -3, end: 4 }, 10)).toEqual({ start: 0, end: 4 });
    expect(clampTrim({ start: 8, end: 30 }, 10)).toEqual({ start: 8, end: 10 });
    expect(() => clampTrim({ start: 5, end: 5.2 }, 10)).toThrow(/half a second/);
  });
});
