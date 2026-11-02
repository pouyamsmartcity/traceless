import { describe, expect, it } from 'vitest';
import { FindingList } from '../src/lib/findings';
import { inspectXmp, parseXmpCoordinate } from '../src/lib/xmp';

const run = (xmp: string) => {
  const out = new FindingList();
  inspectXmp(xmp, out);
  return out.items;
};

describe('XMP', () => {
  it('reads attribute and element forms, and skips longer names with the same start', () => {
    const f = run(
      '<x:xmpmeta><rdf:Description exif:GPSLatitudeRef="N" exif:GPSLatitude="35,41.982N">' +
        '<exif:GPSLongitudeRef>E</exif:GPSLongitudeRef><exif:GPSLongitude>51,20.28E</exif:GPSLongitude>' +
        '<dc:creator><rdf:Seq><rdf:li>Jane &amp; Co</rdf:li></rdf:Seq></dc:creator></rdf:Description></x:xmpmeta>',
    );
    const gps = f.find((x) => x.id === 'gps');
    expect(gps?.geo?.lat).toBeCloseTo(35.6997, 3);
    expect(gps?.geo?.lon).toBeCloseTo(51.338, 3);
    expect(f.find((x) => x.id === 'owner')?.value).toBe('Jane & Co');
  });

  it('parses coordinates', () => {
    expect(parseXmpCoordinate('35,41.982N')).toBeCloseTo(35.6997, 4);
    expect(parseXmpCoordinate('12.5W')).toBe(-12.5);
    expect(parseXmpCoordinate('nonsense')).toBeUndefined();
  });

  it('handles hostile packets quickly (no quadratic search)', () => {
    const evil = '<exif:GPSLatitude '.repeat(20_000) + '<dc:creator>'.repeat(20_000);
    const t0 = performance.now();
    run(evil);
    expect(performance.now() - t0).toBeLessThan(500);
    const huge = 'x'.repeat(2_000_000);
    expect(run(huge).map((x) => x.id)).toEqual(['xmp', 'otherMetadata']);
  });
});
