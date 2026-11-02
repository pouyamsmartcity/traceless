import { MAX_SEAL_BYTES, SealError, isSealed, normalizePassphrase, passphraseProblem, seal, unseal, type SealHeader } from '../lib/seal';

export { MAX_SEAL_BYTES };
import { ICONS, h, icon } from './dom';
import type { Strings } from './i18n';

/**
 * A passphrase field the browser will not offer to save or sync: a plain text field drawn with hidden
 * characters where supported (no <form>, no password manager prompt), else a password field with autofill off.
 */
function secretField(testId: string): HTMLInputElement {
  const masked = typeof CSS !== 'undefined' && CSS.supports?.('-webkit-text-security', 'disc');
  const el = h('input', {
    type: masked ? 'text' : 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    name: `p${Math.random().toString(36).slice(2)}`,
    dir: 'ltr',
    'data-testid': testId,
    'data-lpignore': 'true',
    'data-1p-ignore': 'true',
  });
  if (masked) el.classList.add('masked');
  return el;
}

/** Asks for a passphrase in a small dialog. Resolves null when cancelled. */
export function askPassphrase(t: Strings, mode: 'seal' | 'open'): Promise<string | null> {
  return new Promise((resolve) => {
    const pass = secretField('passphrase');
    const confirm = secretField('passphrase-confirm');
    const error = h('p', { className: 'error', role: 'alert' });
    const ok = h('button', { type: 'button', className: 'btn primary', 'data-testid': 'passphrase-ok' }, icon(ICONS.lock), mode === 'seal' ? t.sealDo : t.sealOpen);
    const cancel = h('button', { type: 'button', className: 'btn ghost' }, t.editorCancel);
    const sheet = h(
      'div',
      { className: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': mode === 'seal' ? t.sealTitle : t.openSealTitle },
      h('h2', {}, mode === 'seal' ? t.sealTitle : t.openSealTitle),
      h('p', { className: 'note' }, mode === 'seal' ? t.sealExplain : t.openSealExplain),
      h('label', {}, t.passphrase, pass),
      mode === 'seal' ? h('label', {}, t.passphraseAgain, confirm) : null,
      error,
      h('div', { className: 'actions' }, ok, cancel),
    );
    const overlay = h('div', { className: 'overlay' }, sheet);
    document.body.appendChild(overlay);
    pass.focus();
    const close = (v: string | null) => {
      pass.value = '';
      confirm.value = '';
      overlay.remove();
      resolve(v);
    };
    const submit = () => {
      if (mode === 'seal') {
        if (passphraseProblem(pass.value)) {
          error.textContent = t.passphraseShort;
          return;
        }
        if (normalizePassphrase(pass.value) !== normalizePassphrase(confirm.value)) {
          error.textContent = t.passphraseMismatch;
          return;
        }
      }
      close(pass.value);
    };
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') close(null);
    });
  });
}

function randomSealName(): string {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return `sealed-${Array.from(a, (b) => (b % 36).toString(36)).join('')}.pakkon`;
}

/** Seals the original file. Returns the sealed file to save, or null when cancelled. */
export async function sealOriginal(file: File, t: Strings): Promise<{ file: File; header: SealHeader } | null> {
  const passphrase = await askPassphrase(t, 'seal');
  if (passphrase === null) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { sealed, header } = await seal(bytes, { name: file.name, type: file.type }, passphrase);
  return { file: new File([sealed as BlobPart], randomSealName(), { type: 'application/octet-stream' }), header };
}

export async function looksSealed(file: File): Promise<boolean> {
  if (/\.pakkon$/i.test(file.name)) return true;
  return isSealed(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
}

export type OpenResult = { ok: true; original: File; header: SealHeader } | { ok: false; reason: SealError['reason'] | 'cancelled' };

/** Opens a sealed file: asks for the passphrase, decrypts, and checks the fingerprint. */
export async function openSealed(file: File, t: Strings): Promise<OpenResult> {
  const passphrase = await askPassphrase(t, 'open');
  if (passphrase === null) return { ok: false, reason: 'cancelled' };
  try {
    const { original, header } = await unseal(new Uint8Array(await file.arrayBuffer()), passphrase);
    return { ok: true, header, original: new File([original as BlobPart], header.name, { type: header.type }) };
  } catch (e) {
    return { ok: false, reason: e instanceof SealError ? e.reason : 'damaged' };
  }
}
