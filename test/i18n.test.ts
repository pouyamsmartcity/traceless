import { describe, expect, it } from 'vitest';
import { LANGS, LANG_NAMES, STRINGS, detectLang, formatNumber, isLang, isRtl, percent, type Strings } from '../src/ui/i18n';

/** Every leaf of a strings object, with its path, so translations can be compared key by key. */
function leaves(o: unknown, path = ''): [string, unknown][] {
  if (typeof o === 'string' || typeof o === 'function') return [[path, o]];
  if (Array.isArray(o)) return o.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [[path, o]];
}

describe('languages', () => {
  it('picks the language from the browser, English otherwise', () => {
    expect(detectLang(['fa-IR', 'en-US'])).toBe('fa');
    expect(detectLang(['fa'])).toBe('fa');
    expect(detectLang(['prs-AF'])).toBe('fa');
    expect(detectLang(['tr-TR', 'en'])).toBe('tr');
    expect(detectLang(['TR'])).toBe('tr');
    expect(detectLang(['de-DE', 'tr-TR'])).toBe('tr');
    expect(detectLang(['en-GB', 'fa-IR'])).toBe('en');
    expect(detectLang(['de-DE', 'ar'])).toBe('en');
    expect(detectLang([])).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });

  it('knows its own languages only', () => {
    expect(LANGS).toEqual(['en', 'fa', 'tr']);
    for (const l of LANGS) expect(isLang(l)).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang(undefined)).toBe(false);
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(isRtl('tr')).toBe(false);
    expect(LANG_NAMES).toEqual({ en: 'English', fa: 'فارسی', tr: 'Türkçe' });
  });

  it('has every text in every language, translated and non-empty', () => {
    const en = leaves(STRINGS.en);
    for (const lang of LANGS) {
      const other = leaves(STRINGS[lang]);
      expect(other.map(([k]) => k), lang).toEqual(en.map(([k]) => k));
      for (const [k, v] of other) {
        if (typeof v === 'string') expect(v.trim(), `${lang} ${k}`).not.toBe('');
        else expect(typeof v, `${lang} ${k}`).toBe('function');
      }
    }
    // Persian text is in Persian script; Turkish uses its own letters somewhere (not left in English).
    expect(STRINGS.fa.tagline).toMatch(/[؀-ۿ]/);
    const trText = leaves(STRINGS.tr).map(([, v]) => (typeof v === 'string' ? v : '')).join(' ');
    expect(trText).toMatch(/[çğıöşüİ]/);
    // Strings that are the same in English and Turkish should be names and units only.
    const same = leaves(STRINGS.tr).filter(([k, v], i) => typeof v === 'string' && v === en[i]![1] && !/^(appName|styleNames\.brand|units\.|listJoin|dataCredit)/.test(k));
    expect(same).toEqual([]);
  });

  it('uses the same app name in every language', () => {
    for (const lang of LANGS) expect(STRINGS[lang].appName).toBe('Traceless');
  });

  it('calls the text functions with sensible results', () => {
    const call = (s: Strings) => [
      s.masksSummary(1, 2, 0, 3, 4),
      s.etaMinutes('5'),
      s.videoDropped(2),
      s.trimmedNote('0:01', '0:09'),
      s.findingsSummary('3', 'GPS'),
      s.report.faces('1'),
      s.sizeLine('1 MB', '2 MB'),
    ];
    for (const lang of LANGS) for (const out of call(STRINGS[lang])) expect(out).not.toMatch(/undefined|NaN|\$\{/);
    expect(STRINGS.en.report.faces('1')).toBe('1 face covered');
    expect(STRINGS.en.report.faces('2')).toBe('2 faces covered');
  });

  it('writes numbers the way each language does', () => {
    expect(formatNumber('fa', 42)).toBe('۴۲');
    expect(formatNumber('en', 42)).toBe('42');
    expect(formatNumber('tr', 42)).toBe('42');
    expect(percent('fa', 42)).toBe('۴۲٪');
    expect(percent('en', 42)).toBe('42%');
    expect(percent('tr', 42)).toBe('%42');
  });
});
