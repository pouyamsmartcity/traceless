import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
// @ts-expect-error plain JavaScript build helper (no type declarations)
import { writeNotices } from './scripts/notices.mjs';

/** Builds the command-line tool and MCP server into one file for Node.js (dist-cli/pakkon.mjs). */
export default defineConfig({
  // The web app's files (models, icons) are not part of the command-line tool.
  publicDir: false,
  plugins: [{ name: 'pakkon-notices', closeBundle: () => writeNotices('dist-cli', ['mediabunny', 'exifr', 'jpeg-js', 'pngjs']) }],
  build: {
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node20',
    ssr: 'src/cli/bin.ts',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { entryFileNames: 'pakkon.mjs', banner: '#!/usr/bin/env node', codeSplitting: false },
    },
  },
  ssr: { noExternal: true },
});
