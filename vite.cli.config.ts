import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

/** Builds the command-line tool and MCP server into one file for Node.js (dist-cli/pakkon.mjs). */
export default defineConfig({
  build: {
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node20',
    ssr: 'src/cli/bin.ts',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { entryFileNames: 'pakkon.mjs', banner: '#!/usr/bin/env node', inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true },
});
