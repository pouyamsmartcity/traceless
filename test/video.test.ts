import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceFromBytes } from '../src/lib/bytes';
import { inspectVideo } from '../src/lib/bmff';
import { cleanVideo } from '../src/lib/clean-video';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/leaky/${name}`, import.meta.url)));

describe.each(['video-location.mp4', 'video-location.mov'])('%s', (name) => {
  it('reveals location, device, dates and a data track', async () => {
    const r = await inspectVideo(sourceFromBytes(fixture(name)));
    expect(r.partial).toBe(false);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['videoLocation', 'dateTaken', 'extraTracks']));
    const loc = r.findings.find((f) => f.id === 'videoLocation' && f.geo);
    expect(loc?.geo?.lat).toBeCloseTo(35.6997, 3);
    expect(loc?.geo?.lon).toBeCloseTo(51.338, 3);
    if (name.endsWith('.mp4')) expect(ids).toContain('deviceModel');
  });

  it('cleans to a file that reveals nothing and keeps picture and sound', async () => {
    const input = fixture(name);
    const { bytes, droppedTracks } = await cleanVideo(new Blob([input]));
    expect(droppedTracks).toBe(1);
    const r = await inspectVideo(sourceFromBytes(bytes));
    expect(r.partial).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.tracks.sort()).toEqual(['soun', 'vide']);
    // No trace of the planted strings anywhere in the file.
    const text = new TextDecoder('latin1').decode(bytes);
    for (const s of ['FakePhone', '35.6997', '+051.338', 'GPS 35', 'FakeCam']) expect(text).not.toContain(s);
  });
});

describe('rotation', () => {
  it('keeps the display rotation of an upright phone video', async () => {
    const { ALL_FORMATS, BufferSource, Input } = await import('mediabunny');
    const rotationOf = async (b: Uint8Array) => {
      const input = new Input({ source: new BufferSource(b), formats: ALL_FORMATS });
      const r = (await input.getPrimaryVideoTrack())?.rotation;
      input.dispose();
      return r;
    };
    const original = fixture('video-rotated.mp4');
    const { bytes } = await cleanVideo(new Blob([original]));
    const before = await rotationOf(original);
    expect(before).not.toBe(0);
    expect(await rotationOf(bytes)).toBe(before);
  });
});
