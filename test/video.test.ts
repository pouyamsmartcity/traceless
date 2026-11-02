import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceFromBytes } from '../src/lib/bytes';
import { inspectVideo } from '../src/lib/bmff';
import { cleanVideo, videoLeftovers } from '../src/lib/clean-video';
import { outputBoxProblems } from '../src/lib/bmff';
import { stripHvcc, stripPacket, streamLeftovers } from '../src/lib/sanitize-video';

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

describe('hidden data inside the stream and track headers', () => {
  it('drops a track name and the language code', async () => {
    const { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, Mp4OutputFormat, Output } = await import('mediabunny');
    const src = fixture('video-location.mp4');
    const input = new Input({ source: new BufferSource(src), formats: ALL_FORMATS });
    const vt = (await input.getPrimaryVideoTrack())!;
    const cfg = (await vt.getDecoderConfig())!;
    const target = new BufferTarget();
    const out = new Output({ format: new Mp4OutputFormat(), target });
    const vs = new EncodedVideoPacketSource((await vt.getCodec())!);
    out.addVideoTrack(vs, { name: 'Phone of Ali Rezaei, Evin', languageCode: 'fas' });
    await out.start();
    let first = true;
    for await (const p of new EncodedPacketSink(vt).packets()) {
      await vs.add(p, first ? { decoderConfig: cfg } : undefined);
      first = false;
    }
    await out.finalize();
    input.dispose();
    const crafted = new Uint8Array(target.buffer!);
    expect(new TextDecoder('latin1').decode(crafted)).toContain('Ali Rezaei');
    const { bytes } = await cleanVideo(new Blob([crafted]));
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('Ali Rezaei');
    expect(await videoLeftovers(bytes)).toEqual([]);
  });

  it('removes encoder and camera data (SEI) from inside the video stream', async () => {
    const src = new Uint8Array(readFileSync(new URL('./fixtures/real/astronaut-pan.mp4', import.meta.url)));
    expect(new TextDecoder('latin1').decode(src)).toContain('x264 - core');
    const { bytes } = await cleanVideo(new Blob([src]));
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('x264');
    expect(await streamLeftovers(bytes)).toEqual([]);
    expect(await videoLeftovers(bytes)).toEqual([]);
  });

  it('the stream check notices SEI that is still there', async () => {
    const src = new Uint8Array(readFileSync(new URL('./fixtures/real/astronaut-pan.mp4', import.meta.url)));
    expect((await streamLeftovers(src)).join()).toMatch(/metadata units/);
  });

  it('the structure check rejects unexpected boxes', () => {
    const bad = fixture('video-location.mp4');
    expect(outputBoxProblems(bad).some((p) => p.includes('unexpected box'))).toBe(true);
  });
});

describe('SEI and AV1 metadata stripping', () => {
  it('removes H.264 SEI NAL units and keeps the rest', () => {
    const nal = (type: number, len: number) => [0, 0, 0, len + 1, type, ...new Array(len).fill(7)];
    const data = new Uint8Array([...nal(6, 5), ...nal(5, 10), ...nal(6, 3)]);
    const r = stripPacket('avc', data, 4);
    expect(r.removed).toBe(2);
    expect(Array.from(r.data)).toEqual(nal(5, 10));
  });
  it('removes HEVC prefix and suffix SEI', () => {
    const nal = (type: number) => [0, 0, 0, 3, type << 1, 1, 9];
    const r = stripPacket('hevc', new Uint8Array([...nal(39), ...nal(1), ...nal(40)]), 4);
    expect(r.removed).toBe(2);
    expect(Array.from(r.data)).toEqual(nal(1));
  });
  it('removes AV1 metadata OBUs', () => {
    const obu = (type: number, len: number) => [(type << 3) | 2, len, ...new Array(len).fill(1)];
    const r = stripPacket('av1', new Uint8Array([...obu(2, 0), ...obu(5, 4), ...obu(6, 3)]), 4);
    expect(r.removed).toBe(1);
    expect(Array.from(r.data)).toEqual([...obu(2, 0), ...obu(6, 3)]);
  });
  it('rejects malformed packets instead of guessing', () => {
    expect(() => stripPacket('avc', new Uint8Array([0, 0, 0, 9, 1]), 4)).toThrow();
  });
  it('removes SEI arrays from hvcC', () => {
    const head = new Array(22).fill(0);
    head[21] = 3;
    const arr = (type: number) => [type, 0, 1, 0, 2, 0xaa, 0xbb];
    const desc = new Uint8Array([...head, 3, ...arr(33), ...arr(39), ...arr(34)]);
    const out = stripHvcc(desc);
    expect(out[22]).toBe(2);
    expect(out.length).toBe(desc.length - 7);
  });
});
