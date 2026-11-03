/**
 * Sealed originals: the untouched original file, encrypted with a passphrase, plus its SHA-256 fingerprint.
 * A journalist can keep it (or give it to a lawyer) and later prove that a shared safe copy came from a real,
 * unedited original, without ever sharing the original itself.
 *
 * Format (all in one file, ".traceless"):
 *   "TRACELESS01\n" (12 bytes; files from before the rename start with "PAKKONSEAL1\n" and open the same way) | salt (16) | iv (12) | AES-256-GCM ciphertext of:
 *       header length (4, big-endian) | JSON header | original bytes
 * The header holds the name, type, size, SHA-256 and seal time, a random secret, and a "seal code":
 * HMAC-SHA-256(secret, original). The seal code can be noted down or even published: without the sealed file
 * (and its passphrase) nobody can link it to the original, but the sealed file proves it later.
 * Passphrases are normalised (NFKC, Persian/Arabic letter forms, invisible joiners, digits) so the same phrase
 * typed on another keyboard still opens the file.
 * The key comes from the passphrase with PBKDF2-SHA-256 (600,000 iterations). Works with WebCrypto in browsers
 * and Node. Nothing is stored by the app; the user saves the file.
 */

const MAGIC = new TextEncoder().encode('TRACELESS01\n');
/** The same format under the app's earlier name; still opened. */
const OLD_MAGIC = new TextEncoder().encode('PAKKONSEAL1\n');
const ITERATIONS = 600_000;

export interface SealHeader {
  v: 1;
  name: string;
  type: string;
  size: number;
  /** Hex SHA-256 of the original bytes (checked on opening; not shown, as it could link a copy to the original). */
  sha256: string;
  /** Hex random secret for the seal code. */
  secret: string;
  /** Hex HMAC-SHA-256(secret, original): safe to note down or publish. */
  code: string;
  /** ISO time the seal was made, from this device's clock. */
  sealedAt: string;
}

/** Largest file that can be sealed: sealing holds a few copies in memory at once. */
export const MAX_SEAL_BYTES = 300 * 1024 * 1024;

export class SealError extends Error {
  constructor(
    readonly reason: 'notSealed' | 'wrongPassphrase' | 'damaged' | 'weakPassphrase' | 'tooLarge',
    message: string,
  ) {
    super(message);
    this.name = 'SealError';
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

/** Makes the same phrase typed on different keyboards (Persian, Arabic, English digits) give the same key. */
export function normalizePassphrase(p: string): string {
  return p
    .normalize('NFKC')
    .replace(/[\u064A\u0649]/g, '\u06CC') // Arabic yeh / alef maksura -> Persian yeh
    .replace(/\u0643/g, '\u06A9') // Arabic kaf -> Persian keheh
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '') // zero-width and direction marks
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .trim();
}

/** At least 10 characters: a sealed file may be attacked offline for a long time. */
export function passphraseProblem(p: string): string | undefined {
  if (normalizePassphrase(p).length < 10) return 'too short';
  return undefined;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret: Uint8Array, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource)));
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizePassphrase(passphrase)) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(original: Uint8Array, meta: { name: string; type: string }, passphrase: string, now = new Date()): Promise<{ sealed: Uint8Array; header: SealHeader }> {
  if (passphraseProblem(passphrase)) throw new SealError('weakPassphrase', 'passphrase too short');
  if (original.length > MAX_SEAL_BYTES) throw new SealError('tooLarge', 'file too large to seal');
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const header: SealHeader = {
    v: 1,
    name: meta.name,
    type: meta.type,
    size: original.length,
    sha256: await sha256Hex(original),
    secret: hex(secret),
    code: await hmacHex(secret, original),
    sealedAt: now.toISOString(),
  };
  const h = new TextEncoder().encode(JSON.stringify(header));
  const plain = new Uint8Array(4 + h.length + original.length);
  new DataView(plain.buffer).setUint32(0, h.length);
  plain.set(h, 4);
  plain.set(original, 4 + h.length);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource));
  plain.fill(0);
  const sealed = new Uint8Array(MAGIC.length + 16 + 12 + cipher.length);
  sealed.set(MAGIC, 0);
  sealed.set(salt, MAGIC.length);
  sealed.set(iv, MAGIC.length + 16);
  sealed.set(cipher, MAGIC.length + 28);
  return { sealed, header };
}

export function isSealed(b: Uint8Array): boolean {
  if (b.length < MAGIC.length) return false;
  return [MAGIC, OLD_MAGIC].some((m) => m.every((x, i) => b[i] === x));
}

function validHeader(x: unknown): SealHeader {
  const o = x as Record<string, unknown>;
  const isHex = (v: unknown, len: number) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${len}}$`).test(v);
  if (
    !o ||
    o.v !== 1 ||
    typeof o.name !== 'string' ||
    o.name.length > 512 ||
    typeof o.type !== 'string' ||
    o.type.length > 128 ||
    typeof o.size !== 'number' ||
    !Number.isSafeInteger(o.size) ||
    o.size < 0 ||
    !isHex(o.sha256, 64) ||
    !isHex(o.secret, 64) ||
    !isHex(o.code, 64) ||
    typeof o.sealedAt !== 'string' ||
    isNaN(Date.parse(o.sealedAt))
  ) {
    throw new Error('invalid header');
  }
  return o as unknown as SealHeader;
}

/** Opens a sealed file and checks the original against its recorded fingerprint and seal code. */
export async function unseal(sealed: Uint8Array, passphrase: string): Promise<{ original: Uint8Array; header: SealHeader }> {
  if (!isSealed(sealed)) throw new SealError('notSealed', 'not a sealed file');
  if (sealed.length < MAGIC.length + 28 + 16) throw new SealError('damaged', 'too short');
  const salt = sealed.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = sealed.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const key = await deriveKey(passphrase, salt);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, sealed.subarray(MAGIC.length + 28) as BufferSource));
  } catch {
    // GCM cannot tell a wrong passphrase from a changed file.
    throw new SealError('wrongPassphrase', 'wrong passphrase or changed file');
  }
  const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  if (4 + n > plain.length) throw new SealError('damaged', 'bad header length');
  let header: SealHeader;
  try {
    header = validHeader(JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n))));
  } catch {
    throw new SealError('damaged', 'bad header');
  }
  const original = plain.subarray(4 + n);
  if (original.length !== header.size || (await sha256Hex(original)) !== header.sha256) {
    throw new SealError('damaged', 'fingerprint does not match');
  }
  const secret = new Uint8Array((header.secret.match(/../g) ?? []).map((x) => parseInt(x, 16)));
  if ((await hmacHex(secret, original)) !== header.code) throw new SealError('damaged', 'seal code does not match');
  return { original, header };
}
