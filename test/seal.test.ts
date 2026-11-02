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
