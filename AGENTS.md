# Traceless: notes for AI agents and developers

Traceless makes photos, videos and voice notes safe to share: it removes hidden location, device and time data,
covers faces, licence plates, text and people, and can change voices. Its users include journalists and activists
whose safety can depend on a file. Read this before changing anything.

## Rules that are not negotiable

1. **Nothing leaves the device.** No network requests, analytics, CDNs or remote models at run time. The web app
   has a strict Content Security Policy (`vite.config.ts`); the command-line tool and MCP server never open a
   socket. All models ship in `public/models/`.
2. **Fail closed.** If a step cannot be done as asked (detection, covering, voice change, the final check), no
   file is offered. The user decides what to do instead. Never fall back silently to a weaker result.
3. **Every output is checked again** by code that does not share the writer's logic (`imageLeftovers`,
   `videoLeftovers`, `audioLeftovers`). A failed check means no file.
4. **Covers are solid.** No blur or pixelation (they can be reversed).
5. **Be honest.** Never say "100% safe". What cannot be hidden is listed in the app and in `docs/SECURITY.md`.
6. **No real personal data in the repository.** Test files use fake values (`scripts/make_fixtures.py`).
7. Do not add AI attribution lines (such as `Co-Authored-By` trailers or "generated with" notes) to commits,
   pull requests or documentation.

## Commands

| | |
|---|---|
| `npm ci` | install (exact versions; `.npmrc` sets `save-exact`) |
| `npm run dev` | app at http://localhost:5173 |
| `npm run build` | type check and production build into `dist/` |
| `npm test` | unit tests (Vitest, Node) |
| `npm run test:e2e` | browser tests (Playwright, Chromium; builds and serves `dist/`) |
| `npm run build:cli` / `npm run test:cli` | command-line tool and MCP server into `dist-cli/traceless.mjs`, and its smoke test |
| `npm run fixtures` | regenerate the leaky test files (needs ffmpeg and ExifTool) |

Before you push: `npm run typecheck && npm test && npm run test:cli`, and the browser tests for anything in
`src/ui/` or `src/lib/`. CI runs all of them (`.github/workflows/ci.yml`).

## Map

```
src/lib/            browser-free building blocks (most are also used by the CLI)
  inspect-image.ts  what a photo reveals (EXIF, XMP, IPTC, C2PA, thumbnails, motion photos...) and edit hints
  jpeg.ts, png.ts   readers and strippers for JPEG segments and PNG chunks
  bmff.ts           MP4/MOV reader: findings, sanity checks against hostile files, output allowlist
  clean-image.ts    photo pipeline in the browser: redraw on canvas, covers, re-encode, strip, check
  clean-video.ts    video rebuild (mediabunny), sound options, final checks
  sanitize-video.ts packet-level rebuild: drops metadata units in video streams and encoder names in sound
  video-mask.ts     covers in videos: sample frames, detect, track, re-encode with covers on every frame
  video-timeline.ts tracking and cover placement between samples (pure, heavily unit-tested)
  clean-audio.ts    voice notes: fresh M4A, optional voice change, checks
  masks.ts          cover shapes and styles (smart, black, brand, sticker), silhouettes
  detect/           ONNX models in a worker: faces (YuNet), plates (YOLOv9-t), text (PP-OCRv3), people (YOLOX-s), outlines (U-2-Net)
  seal.ts           sealed originals (PBKDF2 + AES-GCM, keyed seal code)
  voice.ts, zip.ts, places.ts, eta.ts, findings.ts, xmp.ts, bytes.ts
src/ui/             the app: app.ts (screens and cards), pipeline.ts (per-file processing), editor.ts, i18n.ts (en/fa/tr), styles.css
src/seo/pages.ts    the per-language pages (/, /fa/, /tr/) and sitemap, written at build time
src/sw/             service worker template (offline copy, share target); built by vite.config.ts
src/cli/            command line and MCP server: core.ts (inspect/clean/check), image-node.ts (JPEG/PNG without a browser), mcp.ts, main.ts
e2e/                browser tests (app.spec.ts, features.spec.ts, a11y.spec.ts; helpers in ui.ts)
test/               unit tests and fixtures (test/fixtures/README.md says where each file comes from)
docs/               SECURITY.md (threats and limits), API.md (CLI and MCP), ROADMAP.md, RESEARCH.md
```

## How to customise

- **Default protection or levels:** `PRESETS` and `loadSettings()` in `src/ui/app.ts`.
- **Interface text:** `src/ui/i18n.ts`. English is the main language; every key exists in `en`, `fa` and `tr` (the
  type enforces it, `test/i18n.test.ts` checks nothing is left untranslated). Write plainly; avoid jargon. The app
  starts in the browser's language (`detectLang`), or the page's on `/fa/` and `/tr/`.
- **Search and sharing:** each language's page text, structured data and sitemap are made at build time by
  `src/seo/pages.ts` (title and description come from `pageTitle`/`pageDescription` in `i18n.ts`); the preview
  pictures are drawn by `scripts/og-images.mjs`. The site address is `SITE_URL` (default in `src/site.ts`).
- **A new cover look:** add it to `MaskStyle` and `MASK_STYLES` in `src/lib/masks.ts`, paint it in
  `paintCovers` (keep it opaque), add a swatch in `styles.css` and a name in `i18n.ts`.
- **A new detection model:** add it to `MODELS` in `src/lib/detect/models.ts` with its decoder, plan its passes in
  `detector.ts`, put the file in `public/models/` and record source, licence and SHA-256 in
  `public/models/README.md`. Measure recall before and after (see `docs/RESEARCH.md`).
- **A new kind of leak:** add an id to `FindingId` in `src/lib/findings.ts` (with a severity), detect it in the
  matching inspector, add its text to `i18n.ts`, and add a leaky fixture plus a test that it is found and gone.
- **Agent tools:** `TOOLS` and `callTool` in `src/cli/mcp.ts`; document them in `docs/API.md`.

## Testing conventions

- Every bug fix comes with a test that fails without it.
- Leaky fixtures carry fake values; tests assert both that a leak is reported and that its value is absent from
  the output bytes.
- Covers are checked against their real shape (oval or outline), not their bounding box.
- Long browser tests run on two sizes (`phone`, `desktop`); use the helpers in `e2e/ui.ts` to change options the
  way a user does (through the settings sheet).
