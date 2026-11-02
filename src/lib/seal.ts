/**
 * Sealed originals: the untouched original file, encrypted with a passphrase, plus its SHA-256 fingerprint.
 * A journalist can keep it (or give it to a lawyer) and later prove that a shared safe copy came from a real,
 * unedited original, without ever sharing the original itself.
 *
 * Format (all in one file, ".pakkon"):
 *   "PAKKONSEAL1\n" (12 bytes) | salt (16) | iv (12) | AES-256-GCM ciphertext of:
 *       header length (4, big-endian) | JSON header (name, type, size, sha256, sealedAt) | original bytes
 * The key comes from the passphrase with PBKDF2-SHA-256 (600,000 iterations). Works with WebCrypto in browsers
 * and Node. Nothing is stored by the app; the user saves the file.
 */

const MAGIC = new TextEncoder().encode('PAKKONSEAL1\n');
const ITERATIONS = 600_000;

export interface SealHeader {
  name: string;
  type: string;
  size: number;
  /** Hex SHA-256 of the original bytes. */
  sha256: string;
  /** ISO time the seal was made. */
  sealedAt: string;
}

export class SealError extends Error {
  constructor(
    readonly reason: 'notSealed' | 'wrongPassphrase' | 'damaged' | 'weakPassphrase',
    message: string,
  ) {
    super(message);
    this.name = 'SealError';
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** At least 10 characters: a sealed file may be attacked offline for a long time. */
export function passphraseProblem(p: string): string | undefined {
  if (p.length < 10) return 'too short';
  return undefined;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase) as BufferSource, 'PBKDF2', false, ['deriveKey']);
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
  const header: SealHeader = {
    name: meta.name,
    type: meta.type,
    size: original.length,
    sha256: await sha256Hex(original),
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
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false;
  return true;
}

/** Opens a sealed file and checks the original against its recorded fingerprint. */
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
    header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n))) as SealHeader;
  } catch {
    throw new SealError('damaged', 'bad header');
  }
  const original = plain.slice(4 + n);
  if (original.length !== header.size || (await sha256Hex(original)) !== header.sha256) {
    throw new SealError('damaged', 'fingerprint does not match');
  }
  return { original, header };
}
