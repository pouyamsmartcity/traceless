/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { DEFAULT_SITE_URL, PAGE_PATH, notFoundPage, renderPage, sitemap } from './src/seo/pages.ts';
import { LANGS } from './src/ui/i18n.ts';
// @ts-expect-error plain JavaScript build helper (no type declarations)
import { MODELS_NOTE, writeNotices } from './scripts/notices.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The public address of the site (for links between the language pages, the sitemap and sharing previews). */
const SITE_URL = (() => {
  const url = new URL(process.env.SITE_URL || DEFAULT_SITE_URL);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
})();

/** Files on the site that the app itself never needs, so the offline copy does not download them. */
const NOT_OFFLINE = /^(og-[a-z]+\.jpg|sitemap\.xml|404\.html|robots\.txt|google[0-9a-f]+\.html|SHA256SUMS\.txt)$/;

/** Writes the English, Persian and Turkish pages (/, /fa/, /tr/), the sitemap and 404.html from the built index.html. */
function languagePages(dist: string): void {
  const built = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const lang of LANGS) {
    const file = join(dist, PAGE_PATH[lang], 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage(built, lang, SITE_URL));
  }
  writeFileSync(join(dist, 'sitemap.xml'), sitemap(SITE_URL));
  writeFileSync(join(dist, '404.html'), notFoundPage(SITE_URL));
}

/**
 * The page may only load its own files. No other server can be contacted: not for scripts, styles,
 * fonts, images, nor for sending data (connect-src). 'wasm-unsafe-eval' only allows WebAssembly.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Adds the Content Security Policy to the built page. (Dev mode needs inline styles, so it is build-only.) */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'traceless-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const meta = ctx.server ? '' : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;
        return html.replace('<!-- %CSP% -->', meta);
      },
    },
  };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** Writes sw.js with the list of every built file, so the whole app is stored for offline use. */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'traceless-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const dist = outDir;
      writeNotices(dist, ['mediabunny', 'exifr', 'onnxruntime-web', 'vazirmatn'], MODELS_NOTE);
      languagePages(dist);
      const files = listFiles(dist)
        .map((p) => relative(dist, p).split('\\').join('/'))
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !f.endsWith('.md') && !NOT_OFFLINE.test(f))
        .sort();
      const hash = createHash('sha256');
      // Each entry carries a fingerprint of its content (?v=...), so an update can reuse unchanged files.
      const list: string[] = [];
      for (const f of files) {
        const content = readFileSync(join(dist, f));
        const fileHash = createHash('sha256').update(content).digest('hex').slice(0, 12);
        hash.update(f).update(fileHash);
        list.push(`./${f}?v=${fileHash}`);
        // A page is also asked for by its folder ("./fa/").
        if (f === 'index.html' || f.endsWith('/index.html')) list.push(`./${f.slice(0, -'index.html'.length)}?v=${fileHash}`);
      }
      const template = readFileSync(join(ROOT, 'src/sw/sw-template.js'), 'utf8');
      hash.update(template);
      const version = hash.digest('hex').slice(0, 12);
      const pages = LANGS.map((l) => PAGE_PATH[l]).filter(Boolean);
      writeFileSync(
        join(dist, 'sw.js'),
        template.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(list, null, 2)).replace('__PAGES__', JSON.stringify(pages)),
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [contentSecurityPolicy(), serviceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
