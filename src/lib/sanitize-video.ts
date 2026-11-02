import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoCodec,
} from 'mediabunny';
import { VideoCleanError } from './video-errors';

/**
 * Video streams themselves can carry hidden data, not only the container around them:
 * H.264/HEVC "SEI" messages (camcorders put recording time, camera model and even GPS there; encoders put
 * their name and settings) and AV1 metadata units. This module rebuilds an MP4 packet by packet without them,
 * and checks a file for any that are left. Picture and sound are copied unchanged otherwise.
 */

/** Codecs whose bitstream we can read and clean. Others are refused rather than passed through unchecked. */
const CLEANABLE: VideoCodec[] = ['avc', 'hevc', 'av1', 'vp8', 'vp9'];

function nalLengthSize(codec: VideoCodec, description: Uint8Array | undefined): number {
  if (!description) return 4;
  if (codec === 'avc' && description.length > 4) return (description[4]! & 3) + 1;
  if (codec === 'hevc' && description.length > 21) return (description[21]! & 3) + 1;
  return 4;
}

/** True for NAL units that hold metadata rather than picture data. */
function isMetadataNal(codec: VideoCodec, firstByte: number): boolean {
  if (codec === 'avc') return (firstByte & 0x1f) === 6; // SEI
  const type = (firstByte >> 1) & 0x3f;
  return type === 39 || type === 40; // HEVC prefix/suffix SEI
}

/** Splits length-prefixed NAL units. Throws on a malformed packet instead of guessing. */
function nalUnits(data: Uint8Array, lengthSize: number): Uint8Array[] {
  const units: Uint8Array[] = [];
  let o = 0;
  while (o < data.length) {
    if (o + lengthSize > data.length) throw new VideoCleanError('unsupported', 'truncated NAL length');
    let n = 0;
    for (let i = 0; i < lengthSize; i++) n = n * 256 + data[o + i]!;
    o += lengthSize;
    if (n === 0 || o + n > data.length) throw new VideoCleanError('unsupported', 'bad NAL length');
    units.push(data.subarray(o, o + n));
    o += n;
  }
  return units;
}

function joinNal(units: Uint8Array[], lengthSize: number): Uint8Array {
  let total = 0;
  for (const u of units) total += lengthSize + u.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const u of units) {
    let n = u.length;
    for (let i = lengthSize - 1; i >= 0; i--) {
      out[o + i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    o += lengthSize;
    out.set(u, o);
    o += u.length;
  }
  return out;
}

function readLeb128(b: Uint8Array, o: number): { value: number; size: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if (o + i >= b.length) throw new VideoCleanError('unsupported', 'truncated AV1 size');
    const byte = b[o + i]!;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return { value, size: i + 1 };
  }
  throw new VideoCleanError('unsupported', 'bad AV1 size');
}

/** Removes AV1 metadata OBUs (type 5) from a temporal unit. */
function stripAv1(data: Uint8Array): { data: Uint8Array; removed: number } {
  const keep: Uint8Array[] = [];
  let removed = 0;
  let o = 0;
  while (o < data.length) {
    const header = data[o]!;
    const type = (header >> 3) & 0x0f;
    const hasExtension = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    let end: number;
    if (hasSize) {
      const { value, size } = readLeb128(data, o + 1 + hasExtension);
      end = o + 1 + hasExtension + size + value;
    } else {
      end = data.length; // the last OBU may omit its size
    }
    if (end > data.length) throw new VideoCleanError('unsupported', 'bad AV1 OBU');
    if (type === 5) removed++;
    else keep.push(data.subarray(o, end));
    o = end;
  }
  if (!removed) return { data, removed };
  let total = 0;
  for (const k of keep) total += k.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const k of keep) {
    out.set(k, p);
    p += k.length;
  }
  return { data: out, removed };
}

/** Returns the packet data without metadata units, and how many were removed. */
export function stripPacket(codec: VideoCodec, data: Uint8Array, lengthSize: number): { data: Uint8Array; removed: number } {
  if (codec === 'avc' || codec === 'hevc') {
    const units = nalUnits(data, lengthSize);
    const keep = units.filter((u) => u.length > 0 && !isMetadataNal(codec, u[0]!));
    if (keep.length === units.length) return { data, removed: 0 };
    return { data: joinNal(keep, lengthSize), removed: units.length - keep.length };
  }
  if (codec === 'av1') return stripAv1(data);
  return { data, removed: 0 };
}

/** Removes SEI arrays from an HEVC decoder configuration record (hvcC). avcC holds only SPS/PPS. */
export function stripHvcc(desc: Uint8Array): Uint8Array {
  if (desc.length < 23) throw new VideoCleanError('unsupported', 'short hvcC');
  const numArrays = desc[22]!;
  const parts: Uint8Array[] = [desc.subarray(0, 23)];
  let kept = 0;
  let o = 23;
  for (let a = 0; a < numArrays; a++) {
    if (o + 3 > desc.length) throw new VideoCleanError('unsupported', 'bad hvcC');
    const type = desc[o]! & 0x3f;
    const count = (desc[o + 1]! << 8) | desc[o + 2]!;
    let p = o + 3;
    for (let i = 0; i < count; i++) {
      if (p + 2 > desc.length) throw new VideoCleanError('unsupported', 'bad hvcC');
      p += 2 + ((desc[p]! << 8) | desc[p + 1]!);
    }
    if (p > desc.length) throw new VideoCleanError('unsupported', 'bad hvcC');
    if (type !== 39 && type !== 40) {
      parts.push(desc.subarray(o, p));
      kept++;
    }
    o = p;
  }
  const rest = desc.subarray(o);
  let total = rest.length;
  for (const x of parts) total += x.length;
  const out = new Uint8Array(total);
  let q = 0;
  for (const x of parts) {
    out.set(x, q);
    q += x.length;
  }
  out.set(rest, q);
  out[22] = kept;
  return out;
}

function toBytes(d: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!d) return undefined;
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d as ArrayBuffer);
}

/**
 * Rebuilds an MP4 (as made by our own conversion step) with only the primary video and audio tracks,
 * no track names or tags, and no metadata units inside the video stream.
 */
export async function sanitizeMp4(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    const vt: InputVideoTrack | null = await input.getPrimaryVideoTrack();
    if (!vt) throw new VideoCleanError('noVideo', 'no video track');
    const at: InputAudioTrack | null = await input.getPrimaryAudioTrack();
    const vcodec = await vt.getCodec();
    if (!vcodec || !CLEANABLE.includes(vcodec)) throw new VideoCleanError('unsupported', `cannot clean ${vcodec} streams`);
    const vconfig = await vt.getDecoderConfig();
    if (!vconfig) throw new VideoCleanError('unsupported', 'no decoder config');
    let desc = toBytes(vconfig.description);
    if (vcodec === 'hevc' && desc) desc = stripHvcc(desc);
    const lengthSize = nalLengthSize(vcodec, desc);

    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const vsrc = new EncodedVideoPacketSource(vcodec);
    output.addVideoTrack(vsrc, { rotation: await vt.getRotation() });
    let asrc: EncodedAudioPacketSource | undefined;
    const acodec = at ? await at.getCodec() : null;
    const aconfig = at ? await at.getDecoderConfig() : null;
    if (at && acodec && aconfig) {
      asrc = new EncodedAudioPacketSource(acodec);
      output.addAudioTrack(asrc);
    }
    await output.start();

    const pumpVideo = async () => {
      let first = true;
      for await (const p of new EncodedPacketSink(vt).packets()) {
        const { data } = stripPacket(vcodec, p.data, lengthSize);
        const packet = new EncodedPacket(data, p.type, p.timestamp, p.duration);
        if (first) {
          const decoderConfig: VideoDecoderConfig = { ...vconfig, codec: vconfig.codec };
          if (desc) decoderConfig.description = desc;
          else delete decoderConfig.description;
          await vsrc.add(packet, { decoderConfig });
          first = false;
        } else await vsrc.add(packet);
      }
      vsrc.close();
    };
    const pumpAudio = async () => {
      if (!at || !asrc || !aconfig) return;
      let first = true;
      for await (const p of new EncodedPacketSink(at).packets()) {
        const packet = new EncodedPacket(p.data, p.type, p.timestamp, p.duration);
        if (first) {
          await asrc.add(packet, { decoderConfig: aconfig });
          first = false;
        } else await asrc.add(packet);
      }
      asrc.close();
    };
    await Promise.all([pumpVideo(), pumpAudio()]);
    await output.finalize();
    if (!target.buffer) throw new VideoCleanError('failed', 'no output');
    return new Uint8Array(target.buffer);
  } finally {
    input.dispose();
  }
}

/** Independent check: lists metadata units still present in the video stream of an MP4. */
export async function streamLeftovers(bytes: Uint8Array): Promise<string[]> {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    const problems: string[] = [];
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) return ['no video track'];
    const codec = await vt.getCodec();
    if (!codec || !CLEANABLE.includes(codec)) return [`unchecked codec ${codec}`];
    const config = await vt.getDecoderConfig();
    const desc = toBytes(config?.description);
    if (codec === 'hevc' && desc && stripHvcc(desc).length !== desc.length) problems.push('SEI in hvcC');
    const lengthSize = nalLengthSize(codec, desc);
    let removed = 0;
    for await (const p of new EncodedPacketSink(vt).packets()) removed += stripPacket(codec, p.data, lengthSize).removed;
    if (removed) problems.push(`${removed} metadata units in the video stream`);
    return problems;
  } catch (e) {
    return [`stream not readable: ${e instanceof Error ? e.message : String(e)}`];
  } finally {
    input.dispose();
  }
}
