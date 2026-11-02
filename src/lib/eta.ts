/**
 * Time left for a long step (detecting or re-encoding a video), from how fast it has gone so far.
 * Kept free of browser APIs so it can be unit-tested.
 */

export interface PhaseClock {
  /** The step being timed (a new step restarts the clock). */
  phase: string;
  /** When the clock started (ms) and the fraction done at that moment. */
  t0: number;
  f0: number;
}

/** Starts or keeps the clock for `phase` at fraction `f`; a new phase, or progress going back, restarts it. */
export function tick(clock: PhaseClock | undefined, phase: string, f: number, now: number): PhaseClock {
  if (!clock || clock.phase !== phase || f < clock.f0) return { phase, t0: now, f0: f };
  // Start timing from the first finished piece of work: before it, the models are still loading and the first
  // run is slow, which would make the guess far too long.
  if (clock.f0 === 0) return { phase, t0: now, f0: f };
  return clock;
}

/**
 * Seconds left, or undefined while there is too little to go on (the first seconds and percent of a step
 * are mostly start-up and would give wild guesses).
 */
export function secondsLeft(clock: PhaseClock | undefined, f: number, now: number): number | undefined {
  if (!clock) return undefined;
  const done = f - clock.f0;
  const elapsed = now - clock.t0;
  if (elapsed < 4000 || done < 0.03 || f >= 1) return undefined;
  return ((elapsed / done) * (1 - f)) / 1000;
}

/** Rounded for display: "under a minute" (0) or whole minutes, rounded up. */
export function minutesLeft(seconds: number): number {
  return seconds < 50 ? 0 : Math.ceil(seconds / 60);
}
