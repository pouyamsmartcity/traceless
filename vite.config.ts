/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

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
    name: 'pakkon-csp',
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
    name: 'pakkon-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const dist = join(ROOT, outDir);
      const files = listFiles(dist)
        .map((p) => relative(dist, p).split('\\').join('/'))
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !f.endsWith('.md'))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(dist, f)));
      const template = readFileSync(join(ROOT, 'src/sw/sw-template.js'), 'utf8');
      hash.update(template);
      const version = hash.digest('hex').slice(0, 12);
      const list = ['./', ...files.map((f) => `./${f}`)];
      writeFileSync(join(dist, 'sw.js'), template.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(list, null, 2)));
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
