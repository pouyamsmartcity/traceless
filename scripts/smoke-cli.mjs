// End-to-end check of the built command-line tool and MCP server, the way an agent uses them.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = new URL('../dist-cli/pakkon.mjs', import.meta.url).pathname;
const fixture = (p) => new URL(`../test/fixtures/${p}`, import.meta.url).pathname;
const fail = (msg) => {
  console.error(`smoke test failed: ${msg}`);
  process.exit(1);
};

// 1. Command line: inspect, clean, check.
const dir = mkdtempSync(join(tmpdir(), 'pakkon-smoke-'));
copyFileSync(fixture('leaky/photo-everything.jpg'), join(dir, 'photo.jpg'));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
const inspected = JSON.parse(run('inspect', join(dir, 'photo.jpg'), '--json').stdout);
if (!inspected.leaks.some((l) => l.id === 'gps')) fail('inspect did not find the GPS location');
const cleaned = JSON.parse(run('clean', join(dir, 'photo.jpg'), '--cover', '10,10,40,40,ellipse', '--json').stdout);
if (run('check', cleaned.output).status !== 0) fail('the safe copy did not pass the check');
if (run('check', join(dir, 'photo.jpg')).status !== 1) fail('the leaky original passed the check');

// 2. MCP over stdio: initialize, list tools, call one.
const server = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = [];
let buf = '';
server.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    replies.push(JSON.parse(buf.slice(0, i)));
    buf = buf.slice(i + 1);
  }
});
const send = (m) => server.stdin.write(`${JSON.stringify(m)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect_file', arguments: { path: fixture('leaky/voice-note.ogg') } } });
const deadline = Date.now() + 20000;
while (replies.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
server.kill();
const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
if (byId[1]?.result?.serverInfo?.name !== 'pakkon') fail('initialize');
if (byId[2]?.result?.tools?.length !== 3) fail('tools/list');
if (!byId[3]?.result?.content?.[0]?.text?.includes('Enghelab')) fail('tools/call inspect_file');
if (readdirSync(dir).length !== 2) fail('unexpected files written');
console.log('CLI and MCP server: OK');
