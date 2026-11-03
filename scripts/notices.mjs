// Writes THIRD_PARTY_NOTICES.txt next to a build: the licence of every third-party package shipped in it.
// Used by vite.config.ts (web app) and vite.cli.config.ts (command-line tool).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** onnxruntime-web ships without a licence file; this is its licence (MIT, Microsoft). */
const ORT_LICENSE = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function licenseText(pkg) {
  if (pkg === 'onnxruntime-web') return ORT_LICENSE;
  const dir = join(ROOT, 'node_modules', pkg);
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|ofl|copying)(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`no licence file for ${pkg}`);
  return readFileSync(join(dir, file), 'utf8');
}

export function writeNotices(outDir, packages, extra = '') {
  const parts = [
    'Pakkon is free software under the MIT licence (see LICENSE).',
    'It includes the following third-party software, under their own licences.',
    '',
  ];
  for (const pkg of packages) {
    const meta = JSON.parse(readFileSync(join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8'));
    parts.push('='.repeat(78), `${pkg} ${meta.version} (${meta.license})`, meta.homepage ?? '', '='.repeat(78), licenseText(pkg).trim(), '');
  }
  if (extra) parts.push('='.repeat(78), extra.trim(), '');
  if (!existsSync(outDir)) throw new Error(`no build folder ${outDir}`);
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), parts.join('\n'));
}

export const MODELS_NOTE = `Detection models (public/models/, shipped in models/): see models/README.md in the
source for each model's source, licence (MIT or Apache-2.0) and checksum. Place names: GeoNames (CC BY 4.0).`;
