import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { distanceKm, nearest, parsePlaces } from '../src/lib/places';

const places = parsePlaces(readFileSync(new URL('../public/data/places.tsv', import.meta.url), 'utf8'));

describe('places', () => {
  it('has a usable list', () => {
    expect(places.length).toBeGreaterThan(40000);
  });
  it('finds Tehran for Azadi Square', () => {
    const p = nearest(places, 35.6997, 51.338);
    expect(p?.country).toBe('IR');
    expect(p?.km).toBeLessThan(15);
  });
  it('returns nothing in the middle of the ocean', () => {
    expect(nearest(places, -40, -120)).toBeUndefined();
  });
  it('measures distance', () => {
    expect(distanceKm(35.6997, 51.338, 32.6539, 51.666)).toBeGreaterThan(330);
    expect(distanceKm(35.6997, 51.338, 32.6539, 51.666)).toBeLessThan(345);
  });
});
