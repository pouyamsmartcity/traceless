# Pakkon for programs and AI agents

Pakkon is also a command-line tool and an MCP server, so scripts and AI agents (Claude, Cursor, VS Code, Codex
and other MCP clients) can use it on files of your computer. Like the app, it runs **only on your computer**: it
never opens a network connection, and it never changes or deletes your originals.

| | App (browser) | Command line / MCP |
|---|---|---|
| What a file reveals (photos, videos, voice notes) | yes | yes |
| Photos redrawn from pixels, hidden data removed | JPEG, PNG, WebP, HEIC… | JPEG and PNG |
| Faces and plates found automatically | yes | no: you (or the agent) give the areas to cover |
| Covers in videos | yes | no (use the app) |
| Videos rebuilt with only picture and sound | yes | yes |
| Voice notes rebuilt without tags | yes (re-encoded) | yes (sound frames copied, encoder names removed) |
| Voice change | yes | no (use the app) |
| Independent check of any file | inside every step | `check` / `check_file` |

## Install

Requires Node.js 20 or newer.

```bash
git clone <this repository> pakkon && cd pakkon
```

```bash
npm ci && npm run build:cli
```

This makes one file, `dist-cli/pakkon.mjs`, with no other runtime dependencies. You can copy it anywhere.

## Command line

```bash
node dist-cli/pakkon.mjs inspect photo.jpg
```

```bash
node dist-cli/pakkon.mjs clean photo.jpg --cover 120,80,60,70,ellipse --cover 400,500,140,40 -o safe.jpg
```

```bash
node dist-cli/pakkon.mjs check safe.jpg
```

- `inspect <file> [--json]`: what the file reveals.
- `clean <file> [-o out] [--cover x,y,w,h[,ellipse]]... [--color #rrggbb] [--json]`: writes a safe copy. Without
  `-o`, it is written next to the original with a random name. It never overwrites a file.
- `check <file> [--json]`: exit code 0 when nothing revealing is found, 1 when something is.
- `mcp`: runs the MCP server on standard input/output.

Cover coordinates are pixels of the **upright** picture (as it looks on screen, after the EXIF orientation is
applied), `x,y` is the top-left corner. Covers are solid: nothing under them can be recovered.

## MCP server (for AI agents)

The server speaks the [Model Context Protocol](https://modelcontextprotocol.io) (version 2025-06-18) over stdio.
Replace `/path/to/pakkon` with where you cloned the repository.

**Claude Code** (in this repository it is already set up in `.mcp.json`; elsewhere):

```bash
claude mcp add pakkon -- node /path/to/pakkon/dist-cli/pakkon.mjs mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and most other clients:

```json
{ "mcpServers": { "pakkon": { "command": "node", "args": ["/path/to/pakkon/dist-cli/pakkon.mjs", "mcp"] } } }
```

**VS Code** (`.vscode/mcp.json`):

```json
{ "servers": { "pakkon": { "type": "stdio", "command": "node", "args": ["/path/to/pakkon/dist-cli/pakkon.mjs", "mcp"] } } }
```

**OpenAI Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.pakkon]
command = "node"
args = ["/path/to/pakkon/dist-cli/pakkon.mjs", "mcp"]
```

ChatGPT's connectors need a server on the internet. Pakkon deliberately has none: your files would have to leave
your computer.

### Tools

| Tool | Input | Result |
|---|---|---|
| `inspect_file` | `path` | What the file reveals (read-only) |
| `clean_file` | `path`, optional `output`, `covers` (`[{x, y, w, h, shape?: "rect" \| "ellipse"}]`), `color` | Writes a safe copy; returns its path, what was removed, and notes |
| `check_file` | `path` | Whether the file still reveals anything (read-only) |

Every tool returns a short text for the agent and the same data as `structuredContent` (JSON below).

A typical agent workflow: look at the photo, call `inspect_file`, call `clean_file` with `covers` for every face,
plate or sign it sees, then `check_file` on the result. The server tells agents never to call a file "100% safe".

## JSON

`inspect` (and `inspect_file`):

```json
{
  "kind": "image",
  "format": "jpeg",
  "leaks": [
    { "id": "gps", "severity": "high", "label": "Exact location (GPS coordinates)", "value": "35.69970, 51.33800", "geo": { "lat": 35.6997, "lon": 51.338 } },
    { "id": "deviceModel", "severity": "medium", "label": "Phone or camera model", "value": "FakePhone 15 Pro" }
  ],
  "hints": [{ "id": "editingSoftware", "label": "Saved by photo-editing software", "value": "Photoshop" }],
  "partial": false
}
```

`kind` is `image`, `video`, `audio` or `unknown`, decided from the content (never the file name). Leak `id`s:
`gps`, `videoLocation`, `cityName`, `deviceModel`, `serialNumber`, `lens`, `software`, `dateTaken`, `timeZone`,
`owner`, `uniqueId`, `thumbnail`, `editHistory`, `xmp`, `iptc`, `contentCredentials`, `comment`, `makerNotes`,
`motionPhoto`, `trailingData`, `extraImages`, `colorProfile`, `textChunks`, `extraTracks`, `otherMetadata`.
Severity is `high`, `medium` or `low`.

`clean` (and `clean_file`): `{ "output": "…/pakkon-x1y2z3.jpg", "kind": "image", "removed": [leaks…], "notes": ["…"] }`.

`check` (and `check_file`): `{ "kind": "video", "clean": false, "problems": ["…"], "leaks": [leaks…] }`. The check is
strict: it also reports structures Pakkon does not write (for example other programs' handler names), so a file
made by another tool can fail it even when it hides nothing important. Read `problems` to decide.

## As a library

The functions behind the tools are in `src/cli/core.ts`: `inspect(bytes)`, `clean(bytes, { covers, color })` and
`check(bytes)`, each taking a `Uint8Array`. The browser app's own building blocks are in `src/lib/` (see
[`AGENTS.md`](../AGENTS.md)).
