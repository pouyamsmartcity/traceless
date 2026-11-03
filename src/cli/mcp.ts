import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { check, clean, inspect } from './core';

/**
 * A Model Context Protocol (MCP) server over standard input/output, without any dependency: it lets AI agents
 * (Claude, Cursor and other MCP clients) use Pakkon's tools on files of this computer. It never opens a network
 * connection. JSON-RPC 2.0, one message per line.
 */

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'pakkon', title: 'Pakkon', version: '0.1.0' };

const coverSchema = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'Left edge, in pixels of the upright picture' },
    y: { type: 'number', description: 'Top edge, in pixels' },
    w: { type: 'number', description: 'Width, in pixels' },
    h: { type: 'number', description: 'Height, in pixels' },
    shape: { type: 'string', enum: ['rect', 'ellipse'], description: 'ellipse suits faces (default rect)' },
  },
  required: ['x', 'y', 'w', 'h'],
};

export const TOOLS = [
  {
    name: 'inspect_file',
    title: 'What does this file reveal?',
    description:
      'Lists what a photo (JPEG, PNG, WebP, HEIC), video (MP4, MOV) or voice note (M4A, MP3, OGG...) reveals: GPS location, device model and serial number, owner name, dates and time zone, hidden thumbnails, edit history and more, plus signs of editing for photos. Read-only.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path of the file on this computer' } }, required: ['path'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'clean_file',
    title: 'Make a safe copy',
    description:
      'Writes a safe copy next to the original (never changes the original): photos (JPEG, PNG) are redrawn from their pixels, with optional solid covers over areas you give (e.g. faces you see); videos keep only picture and sound; voice notes become a fresh M4A without tags. The copy is checked again before it is written. Faces in videos and voice changes need the Pakkon app.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the original file' },
        output: { type: 'string', description: 'Where to write the safe copy (default: next to the original, with a random name)' },
        covers: { type: 'array', items: coverSchema, description: 'Areas of a photo to cover with solid colour' },
        color: { type: 'string', description: 'Cover colour as #rrggbb (default #000000)' },
      },
      required: ['path'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'check_file',
    title: 'Is this file clean?',
    description: 'Independent strict check of a file (for example one cleaned by another tool): reports anything that still reveals location, device, time or other hidden data. Read-only.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path of the file' } }, required: ['path'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

type Json = Record<string, unknown>;

function randomName(ext: string): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return `pakkon-${Array.from(a, (b) => (b % 36).toString(36)).join('')}.${ext}`;
}

/** Runs one tool; returns MCP content (text plus the same data as structured JSON). */
export async function callTool(name: string, args: Json): Promise<{ content: { type: 'text'; text: string }[]; structuredContent?: Json; isError?: boolean }> {
  const path = typeof args.path === 'string' ? resolve(args.path) : undefined;
  if (!path) return { content: [{ type: 'text', text: 'Missing "path".' }], isError: true };
  try {
    const bytes = new Uint8Array(await readFile(path));
    if (name === 'inspect_file') {
      const r = await inspect(bytes);
      const lines = r.leaks.length ? r.leaks.map((l) => `- [${l.severity}] ${l.label}${l.value ? `: ${l.value}` : ''}`) : ['- nothing found'];
      return { content: [{ type: 'text', text: `${basename(path)} (${r.kind}, ${r.format}) reveals:\n${lines.join('\n')}` }], structuredContent: r as unknown as Json };
    }
    if (name === 'check_file') {
      const r = await check(bytes);
      return { content: [{ type: 'text', text: r.clean ? 'Clean: nothing revealing was found.' : `NOT clean:\n${[...r.problems, ...r.leaks.map((l) => l.label)].map((x) => `- ${x}`).join('\n')}` }], structuredContent: r as unknown as Json };
    }
    if (name === 'clean_file') {
      const covers = Array.isArray(args.covers) ? (args.covers as Json[]).map((c) => ({ x: Number(c.x), y: Number(c.y), w: Number(c.w), h: Number(c.h), shape: c.shape === 'ellipse' ? ('ellipse' as const) : ('rect' as const) })) : [];
      if (covers.some((c) => ![c.x, c.y, c.w, c.h].every(Number.isFinite) || c.w <= 0 || c.h <= 0)) throw new Error('every cover needs numbers x, y, w > 0, h > 0');
      const r = await clean(bytes, { covers, ...(typeof args.color === 'string' ? { color: args.color } : {}) });
      const out = typeof args.output === 'string' ? resolve(args.output) : join(dirname(path), randomName(r.ext));
      if (out === path) throw new Error('the safe copy must not replace the original');
      if (extname(out).slice(1).toLowerCase() !== r.ext && !(r.ext === 'jpg' && /^\.jpe?g$/i.test(extname(out)))) throw new Error(`the safe copy is a .${r.ext} file; choose an output name ending in .${r.ext}`);
      await writeFile(out, r.bytes, { flag: 'wx' });
      const data = { output: out, kind: r.kind, removed: r.removed, notes: r.notes };
      return {
        content: [{ type: 'text', text: `Safe copy written to ${out}.\nRemoved: ${r.removed.map((l) => l.label).join('; ') || 'nothing was found'}\n${r.notes.join('\n')}` }],
        structuredContent: data as unknown as Json,
      };
    }
    return { content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

/** Answers one JSON-RPC message; returns the response, or undefined for notifications. */
export async function handle(msg: Json): Promise<Json | undefined> {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string | undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return id === undefined ? undefined : fail(-32600, 'Invalid request');
  if (id === undefined) return undefined; // notifications (initialized, cancelled...) need no answer
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Pakkon makes photos, videos and voice notes safe to share, locally. Use inspect_file to see what a file reveals, clean_file to write a safe copy (give covers for faces or other areas you see in a photo), and check_file to verify a file. Never claim a file is 100% safe: things visible in the picture (signs, reflections, tattoos) and voices are not removed unless covered.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const p = (msg.params ?? {}) as Json;
      if (!TOOLS.some((t) => t.name === p.name)) return fail(-32602, `Unknown tool: ${String(p.name)}`);
      return reply(await callTool(String(p.name), (p.arguments ?? {}) as Json));
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

/** Serves MCP on stdin/stdout until stdin closes. Logs go to stderr only (stdout carries the protocol). */
export function serve(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        return;
      }
      const res = await handle(msg).catch((e: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }));
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    });
  });
  process.stderr.write('pakkon MCP server ready (stdio, offline)\n');
}
