import { describe, expect, it } from 'vitest';
import { minutesLeft, secondsLeft, tick } from '../src/lib/eta';

describe('time left', () => {
  it('waits for real progress before guessing', () => {
    let c = tick(undefined, 'detecting', 0, 0);
    c = tick(c, 'detecting', 0.1, 10_000); // first piece done (models loaded): timing starts here
    expect(c.t0).toBe(10_000);
    expect(secondsLeft(c, 0.11, 12_000)).toBeUndefined();
    c = tick(c, 'detecting', 0.35, 30_000);
    // A quarter more done in 20 s: 65% left takes 52 s.
    expect(secondsLeft(c, 0.35, 30_000)).toBeCloseTo(52);
  });

  it('restarts for a new step or when progress goes back', () => {
    const c = tick(undefined, 'detecting', 0.5, 0);
    expect(tick(c, 'cleaning', 0.1, 5000).t0).toBe(5000);
    expect(tick(c, 'detecting', 0.2, 5000).t0).toBe(5000);
    expect(tick(c, 'detecting', 0.6, 5000)).toBe(c);
  });

  it('rounds for display', () => {
    expect(minutesLeft(20)).toBe(0);
    expect(minutesLeft(61)).toBe(2);
    expect(minutesLeft(120)).toBe(2);
  });
});

describe('time left: odd progress', () => {
  it('never guesses from a progress that is not a number', () => {
    const c = tick(tick(undefined, 'cleaning', 0, 0), 'cleaning', 0.2, 1000);
    expect(secondsLeft(c, Number.NaN, 20_000)).toBeUndefined();
  });

  it('times faces and text in a photo separately', () => {
    let c = tick(undefined, 'detecting', 0, 0);
    c = tick(c, 'detecting', 0.11, 1000);
    c = tick(c, 'text', 0.2, 60_000);
    expect(c.t0).toBe(60_000);
  });
});
