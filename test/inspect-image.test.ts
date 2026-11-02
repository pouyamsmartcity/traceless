import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectImage } from '../src/lib/inspect-image';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/leaky/${name}`, import.meta.url)));
const ids = (r: { findings: { id: string }[] }) => r.findings.map((f) => f.id);

describe('inspectImage', () => {
  it('finds every planted leak in the JPEG', async () => {
    const r = await inspectImage(fixture('photo-everything.jpg'));
    expect(r.kind).toBe('jpeg');
    expect(r.partial).toBe(false);
    expect(r.orientation).toBe(6);
    const gps = r.findings.find((f) => f.id === 'gps' && f.geo);
    expect(gps?.geo?.lat).toBeCloseTo(35.6997, 3);
    expect(gps?.geo?.lon).toBeCloseTo(51.338, 3);
    expect(ids(r)).toEqual(
      expect.arrayContaining([
        'deviceModel', 'serialNumber', 'lens', 'software', 'dateTaken', 'timeZone', 'owner', 'uniqueId',
        'thumbnail', 'xmp', 'editHistory', 'iptc', 'cityName', 'contentCredentials', 'comment', 'motionPhoto',
      ]),
    );
    expect(r.findings.find((f) => f.id === 'deviceModel')?.value).toBe('FakePhone Co FakePhone 15 Pro');
  });

  it('finds leaks in the PNG screenshot, including bytes after the end', async () => {
    const r = await inspectImage(fixture('screenshot-leaky.png'));
    expect(r.kind).toBe('png');
    expect(ids(r)).toEqual(expect.arrayContaining(['gps', 'deviceModel', 'owner', 'textChunks', 'trailingData']));
  });

  it('finds leaks in WebP', async () => {
    const r = await inspectImage(fixture('photo-leaky.webp'));
    expect(r.kind).toBe('webp');
    expect(ids(r)).toEqual(expect.arrayContaining(['gps', 'deviceModel', 'owner', 'xmp', 'cityName']));
  });

  it('does not crash on garbage', async () => {
    const r = await inspectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3]));
    expect(r.kind).toBe('jpeg');
    expect(r.partial).toBe(true);
  });
});

describe('edit hints', () => {
  it('notices an editor, a later modify date and a cropped picture', async () => {
    const r = await inspectImage(fixture('photo-edited.jpg'));
    const ids = r.hints.map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(['editingSoftware', 'dateMismatch', 'thumbnailCropped']));
    expect(r.hints.find((h) => h.id === 'editingSoftware')?.value).toContain('Photoshop');
    expect(ids).not.toContain('noCameraData');
  });

  it('a camera photo without camera data looks re-saved', async () => {
    const { stripJpeg } = await import('../src/lib/jpeg');
    const r = await inspectImage(stripJpeg(fixture('photo-everything.jpg')));
    expect(r.hints.map((h) => h.id)).toEqual(['noCameraData']);
  });

  it('gives no edit hints for an ordinary camera photo', async () => {
    const r = await inspectImage(fixture('photo-everything.jpg'));
    expect(r.hints.map((h) => h.id)).not.toContain('editingSoftware');
    expect(r.hints.map((h) => h.id)).not.toContain('thumbnailCropped');
    expect(r.thumbnail?.length).toBeGreaterThan(100);
  });
});
