import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAGE_PATH, PAGE_TEXT, renderPage, sitemap } from '../src/seo/pages';
import { LANGS, STRINGS } from '../src/ui/i18n';

const SITE = 'https://example.github.io/traceless/';
/** Shaped like the built page: relative links to the app's files, CSP, title and description. */
const built = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .replace('<!-- %CSP% -->', `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'" />`)
  .replace('<script type="module" src="/src/main.ts"></script>', '<script type="module" crossorigin src="./assets/index-abc.js"></script>\n    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">');

function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
}

describe('language pages', () => {
  it('gives each language its own title, description, address and direction', () => {
    for (const lang of LANGS) {
      const html = renderPage(built, lang, SITE);
      const url = SITE + PAGE_PATH[lang];
      expect(html).toContain(`<html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}"`);
      expect(html).toContain(`<title>${STRINGS[lang].pageTitle}</title>`);
      expect(html).toContain(`<meta name="description" content="${STRINGS[lang].pageDescription}" />`);
      expect(html).toContain(`<link rel="canonical" href="${url}" />`);
      expect(html).toContain(`<meta property="og:image" content="${SITE}og-${lang}.jpg" />`);
      // Every page lists every language and a default.
      for (const l of LANGS) expect(html).toContain(`<link rel="alternate" hreflang="${l}" href="${SITE + PAGE_PATH[l]}" />`);
      expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE}" />`);
      // Exactly one title and description (the original ones are replaced, not added to).
      expect(html.match(/<title>/g)).toHaveLength(1);
      expect(html.match(/<meta name="description"/g)).toHaveLength(1);
      // Readable text for search engines and for anyone without JavaScript.
      expect(html).toContain(PAGE_TEXT[lang].headline);
      for (const { q } of PAGE_TEXT[lang].faq) expect(html).toContain(q.replace(/&/g, '&amp;'));
      // The security policy is kept.
      expect(html).toContain('Content-Security-Policy');
    }
  });

  it('only the Persian and Turkish pages fix the language; the main page follows the browser', () => {
    expect(renderPage(built, 'en', SITE)).not.toContain('data-page-lang');
    expect(renderPage(built, 'fa', SITE)).toContain('data-page-lang="fa"');
    expect(renderPage(built, 'tr', SITE)).toContain('data-page-lang="tr"');
  });

  it('points pages in a folder to the app files one level up', () => {
    const en = renderPage(built, 'en', SITE);
    const fa = renderPage(built, 'fa', SITE);
    expect(en).toContain('src="./assets/index-abc.js"');
    expect(en).toContain('href="./manifest.webmanifest"');
    expect(en).toContain('href="./fa/"');
    expect(fa).toContain('src="../assets/index-abc.js"');
    expect(fa).toContain('href="../assets/index-abc.css"');
    expect(fa).toContain('href="../manifest.webmanifest"');
    expect(fa).toContain('href="../icons/apple-touch-icon.png"');
    expect(fa).toContain('href="../tr/"');
    expect(fa).not.toMatch(/(src|href)="\.\/(?!\/)/);
    // No <base>: the security policy forbids it.
    expect(fa).not.toContain('<base');
  });

  it('describes the app with valid structured data', () => {
    for (const lang of LANGS) {
      const [app, faq] = jsonLd(renderPage(built, lang, SITE));
      expect(app).toMatchObject({ '@type': 'WebApplication', name: 'Traceless', url: SITE + PAGE_PATH[lang], inLanguage: lang, isAccessibleForFree: true });
      expect(app!.alternateName).toEqual(['بی‌ردپا', 'İzsiz']);
      expect(faq).toMatchObject({ '@type': 'FAQPage' });
      expect((faq!.mainEntity as unknown[]).length).toBe(PAGE_TEXT[lang].faq.length);
    }
  });

  it('escapes text so it can never break out of the page', () => {
    const html = renderPage(built.replace('</title>', '</title>'), 'en', 'https://example.org/a"b<c>/');
    expect(html).not.toContain('a"b<c>');
    for (const block of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) expect(block[1]).not.toContain('<');
  });

  it('refuses a page it cannot recognise instead of publishing it half-made', () => {
    expect(() => renderPage('<html><body></body></html>', 'fa', SITE)).toThrow(/not found/);
  });

  it('never says "100% safe" except to say no tool can promise it', () => {
    for (const lang of LANGS) {
      const all = JSON.stringify(PAGE_TEXT[lang]) + STRINGS[lang].pageTitle + STRINGS[lang].pageDescription;
      for (const m of all.matchAll(/100\s?%|%\s?100|صددرصد/g)) {
        const around = all.slice(Math.max(0, m.index! - 80), m.index! + 20);
        expect(around, lang).toMatch(/no tool|هیچ ابزاری|hiçbir araç/i);
      }
    }
  });

  it('lists every language page in the sitemap, with its alternates', () => {
    const xml = sitemap(SITE);
    for (const lang of LANGS) expect(xml).toContain(`<loc>${SITE + PAGE_PATH[lang]}</loc>`);
    expect(xml.match(/<url>/g)).toHaveLength(LANGS.length);
    expect(xml.match(/hreflang="x-default"/g)).toHaveLength(LANGS.length);
  });
});
