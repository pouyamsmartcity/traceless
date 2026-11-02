/** Offline "nearest place" lookup for a GPS point, using the bundled GeoNames extract. */

export interface Place {
  name: string;
  country: string;
  lat: number;
  lon: number;
}

export interface NearestPlace extends Place {
  km: number;
}

export function parsePlaces(tsv: string): Place[] {
  const out: Place[] = [];
  for (const line of tsv.split('\n')) {
    const [name, country, lat, lon] = line.split('\t');
    if (!name || !country || lat === undefined || lon === undefined) continue;
    const p = { name, country, lat: Number(lat), lon: Number(lon) };
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) out.push(p);
  }
  return out;
}

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function nearest(places: Place[], lat: number, lon: number): NearestPlace | undefined {
  let best: Place | undefined;
  let bestKm = Infinity;
  for (const p of places) {
    // Cheap pre-filter on latitude before the exact distance.
    if (Math.abs(p.lat - lat) * 111 > bestKm) continue;
    const km = distanceKm(lat, lon, p.lat, p.lon);
    if (km < bestKm) {
      bestKm = km;
      best = p;
    }
  }
  return best && bestKm < 300 ? { ...best, km: bestKm } : undefined;
}

let cache: Promise<Place[]> | undefined;

/** Loads the place list from this site's own files (never from elsewhere). */
export function loadPlaces(base: string): Promise<Place[]> {
  cache ??= fetch(new URL('data/places.tsv', base).href)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`places ${r.status}`))))
    .then(parsePlaces)
    .catch((e: unknown) => {
      cache = undefined;
      throw e;
    });
  return cache;
}
