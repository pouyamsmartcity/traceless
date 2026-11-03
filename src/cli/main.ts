import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { check, clean, inspect } from './core';
import { serve, SERVER_INFO } from './mcp';

const HELP = `Pakkon ${SERVER_INFO.version} — make photos, videos and voice notes safe to share (runs offline)

Usage:
  pakkon inspect <file> [--json]            What the file reveals (location, device, time...)
  pakkon clean <file> [-o <out>] [--cover x,y,w,h[,ellipse]]... [--color #rrggbb] [--json]
                                            Write a safe copy (never changes the original)
  pakkon check <file> [--json]              Does the file still reveal anything? (exit code 1 if so)
  pakkon mcp                                Run as an MCP server for AI agents (stdio)

Photos: JPEG and PNG are redrawn from their pixels (other formats: use the Pakkon app).
Videos: rebuilt with only picture and sound (to cover faces in videos, use the app).
Voice notes: a fresh M4A without tags (to change the voice, use the app).
`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function randomName(ext: string): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return `pakkon-${Array.from(a, (b) => (b % 36).toString(36)).join('')}.${ext}`;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, file, ...rest] = argv;
  const json = argv.includes('--json');
  const print = (human: string, data: unknown) => process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
  if (cmd === 'mcp') {
    serve();
    return -1; // keeps running
  }
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || !file) {
    process.stdout.write(HELP);
    return cmd ? 2 : 0;
  }
  const path = resolve(file);
  const bytes = new Uint8Array(await readFile(path));
  if (cmd === 'inspect') {
    const r = await inspect(bytes);
    const lines = r.leaks.map((l) => `  [${l.severity}] ${l.label}${l.value ? `: ${l.value}` : ''}`);
    const hints = r.hints.map((h) => `  (hint) ${h.label}${h.value ? `: ${h.value}` : ''}`);
    print(`${file} (${r.kind}, ${r.format})\n${lines.length ? lines.join('\n') : '  nothing revealing found'}${hints.length ? `\n${hints.join('\n')}` : ''}`, r);
    return 0;
  }
  if (cmd === 'check') {
    const r = await check(bytes);
    print(r.clean ? `${file}: clean` : `${file}: NOT clean\n${[...r.problems, ...r.leaks.map((l) => l.label)].map((x) => `  - ${x}`).join('\n')}`, r);
    return r.clean ? 0 : 1;
  }
  if (cmd === 'clean') {
    const covers: { x: number; y: number; w: number; h: number; shape: 'rect' | 'ellipse' }[] = [];
    rest.forEach((a, i) => {
      if (a !== '--cover') return;
      const parts = (rest[i + 1] ?? '').split(',');
      const [x, y, w, h] = parts.slice(0, 4).map(Number);
      if (![x, y, w, h].every((n) => Number.isFinite(n)) || !(w! > 0) || !(h! > 0)) throw new Error(`bad --cover "${rest[i + 1] ?? ''}" (expected x,y,w,h)`);
      covers.push({ x: x!, y: y!, w: w!, h: h!, shape: parts[4] === 'ellipse' ? 'ellipse' : 'rect' });
    });
    const color = arg(rest, '--color');
    const r = await clean(bytes, { covers, ...(color ? { color } : {}) });
    const out = resolve(arg(rest, '-o') ?? arg(rest, '--output') ?? join(dirname(path), randomName(r.ext)));
    if (out === path) throw new Error('the safe copy must not replace the original');
    await writeFile(out, r.bytes, { flag: 'wx' });
    print(`Safe copy: ${out}\nRemoved: ${r.removed.map((l) => l.label).join('; ') || 'nothing was found'}\n${r.notes.join('\n')}`, { output: out, kind: r.kind, removed: r.removed, notes: r.notes });
    return 0;
  }
  process.stdout.write(HELP);
  return 2;
}
