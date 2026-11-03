import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODELS } from '../src/lib/detect/models';

describe('shipped models', () => {
  const readme = readFileSync(new URL('../public/models/README.md', import.meta.url), 'utf8');
  for (const spec of Object.values(MODELS)) {
    it(`${spec.file} matches the checksum recorded in public/models/README.md`, () => {
      const name = spec.file.replace(/^models\//, '');
      const row = readme.split('\n').find((l) => l.startsWith(`| \`${name}\``));
      expect(row, `no row for ${name}`).toBeDefined();
      const recorded = [...row!.matchAll(/`([0-9a-f]{64})`/g)].map((m) => m[1]).pop();
      const actual = createHash('sha256').update(readFileSync(new URL(`../public/${spec.file}`, import.meta.url))).digest('hex');
      expect(actual).toBe(recorded);
    });
  }
});
