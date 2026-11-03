import { describe, expect, it } from 'vitest';
import { SealError, isSealed, passphraseProblem, seal, sha256Hex, unseal } from '../src/lib/seal';

const original = new TextEncoder().encode('the untouched original photo bytes, with GPS 35.6997 51.3380');

describe('sealed originals', () => {
  it('round-trips with the right passphrase and checks the fingerprint', async () => {
    const { sealed, header } = await seal(original, { name: 'IMG_0042.jpg', type: 'image/jpeg' }, 'correct horse battery', new Date('2026-11-02T10:00:00Z'));
    expect(isSealed(sealed)).toBe(true);
    expect(header.sha256).toBe(await sha256Hex(original));
    // Nothing of the original or its name is readable in the sealed file.
    const text = new TextDecoder('latin1').decode(sealed);
    expect(text).not.toContain('GPS');
    expect(text).not.toContain('IMG_0042');
    const opened = await unseal(sealed, 'correct horse battery');
    expect(Array.from(opened.original)).toEqual(Array.from(original));
    expect(opened.header.name).toBe('IMG_0042.jpg');
    expect(opened.header.sealedAt).toBe('2026-11-02T10:00:00.000Z');
  }, 30_000);

  it('writes the new name in the header and still opens files sealed under the earlier name', async () => {
    const { sealed } = await seal(original, { name: 'a.jpg', type: 'image/jpeg' }, 'correct horse battery');
    expect(new TextDecoder().decode(sealed.subarray(0, 12))).toBe('TRACELESS01\n');
    const old = new Uint8Array(sealed);
    old.set(new TextEncoder().encode('PAKKONSEAL1\n'), 0);
    expect(isSealed(old)).toBe(true);
    expect(Array.from((await unseal(old, 'correct horse battery')).original)).toEqual(Array.from(original));
    const other = new Uint8Array(sealed);
    other[0] = 0x58;
    expect(isSealed(other)).toBe(false);
  }, 30_000);

  it('refuses a wrong passphrase and a changed file', async () => {
    const { sealed } = await seal(original, { name: 'a.jpg', type: 'image/jpeg' }, 'correct horse battery');
    await expect(unseal(sealed, 'wrong passphrase!!')).rejects.toBeInstanceOf(SealError);
    const changed = new Uint8Array(sealed);
    changed[changed.length - 5]! ^= 1;
    await expect(unseal(changed, 'correct horse battery')).rejects.toMatchObject({ reason: 'wrongPassphrase' });
    await expect(unseal(new Uint8Array([1, 2, 3]), 'x'.repeat(12))).rejects.toMatchObject({ reason: 'notSealed' });
  }, 30_000);

  it('asks for a passphrase of at least 10 characters', async () => {
    expect(passphraseProblem('short')).toBeDefined();
    expect(passphraseProblem('long enough pass')).toBeUndefined();
    await expect(seal(original, { name: 'a', type: 'b' }, 'short')).rejects.toMatchObject({ reason: 'weakPassphrase' });
  });

  it('two seals of the same file differ (fresh salt and IV)', async () => {
    const a = await seal(original, { name: 'a', type: 'b' }, 'correct horse battery');
    const b = await seal(original, { name: 'a', type: 'b' }, 'correct horse battery');
    expect(Buffer.from(a.sealed).equals(Buffer.from(b.sealed))).toBe(false);
  }, 30_000);
});

describe('passphrases typed on different keyboards', () => {
  it('opens with the same phrase typed with Arabic letters, Persian digits or a zero-width joiner', async () => {
    const { normalizePassphrase } = await import('../src/lib/seal');
    const persian = 'رمز یک کیف ۱۲۳۴';
    const arabicKeyboard = 'رمز يك كيف 1234';
    const withZwnj = 'رمز\u200cیک کیف ١٢٣٤';
    expect(normalizePassphrase(arabicKeyboard)).toBe(normalizePassphrase(persian));
    const { sealed } = await seal(original, { name: 'a.jpg', type: 'image/jpeg' }, persian + ' اضافه');
    await expect(unseal(sealed, arabicKeyboard + ' اضافه')).resolves.toBeTruthy();
    expect(normalizePassphrase(withZwnj)).toBe(normalizePassphrase('رمزیک کیف ۱۲۳۴'));
  }, 60_000);
});

describe('seal code', () => {
  it('is not the plain fingerprint and changes with every seal', async () => {
    const a = await seal(original, { name: 'a', type: 'b' }, 'correct horse battery');
    const b = await seal(original, { name: 'a', type: 'b' }, 'correct horse battery');
    expect(a.header.code).not.toBe(a.header.sha256);
    expect(a.header.code).not.toBe(b.header.code);
    expect(a.header.code).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('refuses files too large to seal', async () => {
    const { MAX_SEAL_BYTES } = await import('../src/lib/seal');
    const big = { length: MAX_SEAL_BYTES + 1 } as unknown as Uint8Array;
    await expect(seal(big, { name: 'a', type: 'b' }, 'correct horse battery')).rejects.toMatchObject({ reason: 'tooLarge' });
  });
});
