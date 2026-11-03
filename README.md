# Traceless: remove photo and video metadata, cover faces, offline

**English** · [فارسی](README.fa.md) · [Türkçe](README.tr.md)

Make a photo, video or voice note safe to share, in one step, fully offline. Traceless removes the hidden data
(EXIF metadata, GPS location, phone model and serial number, dates) that can reveal where, when and with which device
a file was made, and covers faces, licence plates and text with solid colour. Free and open source. Nothing is
uploaded.

In Persian it is called «بی‌ردپا», in Turkish "İzsiz": both mean the same, "without a trace".

**Use it:** https://pouyamsmartcity.github.io/traceless/ (also in [Persian](https://pouyamsmartcity.github.io/traceless/fa/)
and [Turkish](https://pouyamsmartcity.github.io/traceless/tr/)). Open it once with internet; after that it works
offline, and it can be installed on the phone's home screen.

- **Offline.** Everything runs on your phone or computer. The page is not allowed to contact any server (strict
  Content Security Policy), there are no accounts and no analytics. After the first visit it works without internet.
- **Rebuilt from pixels.** Photos are redrawn into a brand-new file. Location, phone model, serial numbers, owner
  name, dates, hidden thumbnails, edit history, Content Credentials (C2PA), Motion Photo videos and leftovers of
  cropped screenshots stay behind. The new file is checked again before you get it.
- **Faces and plates covered, in photos and videos.** On-device detection finds faces (also small faces in crowds)
  and licence plates, including Iranian plates. Covers are solid fills, because blur and pixelation can sometimes be
  reversed, drawn in clean shapes: ovals for faces, rounded shapes for plates and text, and each person's own
  silhouette (found by a segmentation network) when whole people are covered. Four looks: "smart" (a colour taken
  from around the cover, so it sits naturally in the picture), black, Traceless's green with its eraser mark, and a
  friendly "sticker" (faces become a solid yellow smiley). You can add or remove covers by hand, and drag across a
  picture to compare it with the original. In videos, every face is tracked and covered on every frame; a filmstrip
  of the safe video lets you check the covers quickly.
- **Whole people covered on request** (body, clothes, hair), for when clothes or hair could identify someone
  (YOLOX-s person detection, Apache-2.0). In videos the silhouette follows each person between sampled frames.
- **Text covered on request.** Street and shop signs, names and numbers (Persian and Latin script) can be covered
  too; tap a cover to keep a piece of text visible.
- **Extra protection on request.** Makes it much harder to link a photo to a camera through its sensor's noise
  pattern (smaller, very slightly turned and trimmed picture, fresh grain).
- **Change voices or remove the sound** in videos on request (voices and background sounds can identify people
  and places). Voices are made deeper by a random, slowly drifting factor: this stops casual listeners, not someone who works to undo it; words and accents stay. Removing the sound is the safe choice.
- **Voice notes and recordings.** Voice memos and messenger voice notes (M4A, MP3, OGG/Opus, WAV and more) can carry
  a place-named title, the speaker's name, the date, the recording app, a location and a cover picture. Traceless
  re-encodes the sound into a fresh M4A that holds nothing else, and can change the voice too.
- **Smaller files on request** for slow or expensive connections: photos at most 1600 pixels, videos at most 1280
  pixels at a lower bitrate, voice notes at 32 kbit/s. Every card shows the size before and after.
- **Keep only what you need.** Cut a video to the part that matters (the picture is encoded again, so nothing
  from before the cut survives), or crop a photo in the editor; covers move with the picture.
- **Wipe in one tap.** The bin in the header forgets every original and copy in the app at once; "auto-forget" does
  it by itself five minutes after the app goes to the background.
- **Save all as one ZIP** (files stored as they are, with no real dates inside), or share them all at once.
- **Seal the original** (optional): lock the untouched original with a passphrase and record its fingerprint, to
  prove one day that a shared photo is real, without ever sharing the original. Open a `.traceless` file in Traceless to
  check it.
- **Take photos inside Traceless** on phones, so the original never lands in the gallery.
- **Warnings and hints:** "this photo may show where it was taken" when signs, writing or plates stay uncovered;
  "at least N people are visible" for crowds; and for photos you receive, signs of editing (editor name, changed
  dates, a hidden thumbnail that shows a different or uncropped picture), as hints, never proof.
- **Fails safe.** If finding faces or covering a video fails, no copy is offered until you cover things by hand or
  explicitly continue without covering. Every output is checked again before you get it.
- **A checklist before sending** for what software cannot judge: reflections, signs, tattoos, shadows, voices.
- **"What did this file reveal?"** Before cleaning, Traceless lists in plain words what the file was giving away, and
  shows the nearest town for a GPS location (from an offline list).
- **Videos.** Rebuilt into a fresh MP4 with only picture and sound; location, device tags, dates, track names, extra
  data tracks (such as GPS tracks) and metadata inside the video stream itself (camcorders store time, model and GPS
  there) are dropped. With covering on, the picture is re-encoded with covers on every frame;
  with covering off, picture and sound are copied without quality loss. Devices that cannot re-encode video still get
  the hidden data removed, with a clear warning that faces were not covered.
- **English, Persian and Turkish**, chosen from the browser's language (or the page: `/fa/`, `/tr/`) and changeable
  at any time. Random output file names. Installable on Android, iPhone and desktop; on Android
  you can share photos straight into Traceless from the gallery.

## What Traceless cannot do

Traceless never claims a file is "100% safe". It does not hide:

- what is visible in the picture: signs, landmarks, shadows, reflections, clothes, tattoos;
- faces or plates the detector missed, so always look at the picture before sending. On 40 crowd photos from the
  WIDER FACE set it covered 97% of faces 40 px or larger, 93% of faces 20-40 px, and 56% of tiny faces under 20 px
  (each photo is also checked mirrored);
- the camera sensor's noise pattern (PRNU), which can link photos to the same camera ("extra protection" makes this
  much harder, not impossible);
- **words, accents and background sounds** in videos (voices can be changed or the sound removed);
- faces, plates and text in videos on devices that cannot re-encode video (the app says so and makes no copy
  until you decide);
- copies already sent, or data a messenger adds afterwards.

See [docs/SECURITY.md](docs/SECURITY.md) for the full security and privacy model, including how each claim is
tested.

## Supported files

| Input | Output | Notes |
|---|---|---|
| JPEG, WebP, HEIC/HEIF*, AVIF* | JPEG | *if the browser can open it (Safari opens iPhone HEIC photos) |
| PNG, GIF, BMP | PNG | Screenshots stay sharp. Animations keep the first frame only. |
| MP4, MOV, M4V, 3GP, MTS/M2TS/TS, MKV, WebM | MP4 | Up to 2 GB; the new video is built in memory. Covering faces needs a browser that can re-encode video (recent Chrome, Safari, Firefox). |

Photos above 16 megapixels are scaled down to 16 megapixels (the limit of iPhone Safari).

## How it works

```
file ──► inspect (what does it reveal?) ──► decode pixels ──► detect faces + plates (worker, WebAssembly)
                                                   │
                                                   ▼
                     new canvas ──► paint solid covers ──► encode ──► strip to picture data only
                                                                         │
                                                                         ▼
                                                independent re-check ──► share / save
```

- Inspection: own readers for JPEG segments, PNG chunks, WebP chunks and MP4/MOV boxes, plus
  [exifr](https://github.com/MikeKovarik/exifr) for EXIF/IPTC values.
- Detection: [ONNX Runtime Web](https://onnxruntime.ai/) running
  [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (faces) and a YOLOv9-t plate
  model from [open-image-models](https://github.com/ankandrew/open-image-models); optional text (PaddleOCR),
  people (YOLOX-s) and outline (U-2-Net) models. See
  [`public/models/README.md`](public/models/README.md) for sources, licences and checksums.
- Video: [Mediabunny](https://mediabunny.dev/) re-packages the file; our own reader checks the result.
- Offline: a service worker stores the whole app (about 48 MB, once; most of it is the detection models and runtime).

## For programs and AI agents

Traceless is also a command-line tool and an [MCP](https://modelcontextprotocol.io) server, so scripts and AI agents
(Claude, Cursor, VS Code, Codex and other MCP clients) can inspect, clean and check files on your computer, still
fully offline. See [`docs/API.md`](docs/API.md). Developers and coding agents: start with [`AGENTS.md`](AGENTS.md).

## Development

Requires Node.js 22.

```bash
npm ci
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` runs the unit tests (leak readers, cleaning, video stream sanitising, detection maths, and fuzz tests with
thousands of damaged files). `npm run test:e2e` builds the app and runs the browser tests with Playwright on phone and
desktop sizes: leaky files are cleaned, faces, an Iranian plate and text are covered, moving faces are covered in
videos (also rotated and late-starting files), covering fails safe, the app works offline, the share sheet works, and
no request leaves the site.

The leaky test files are generated by `scripts/make_fixtures.py` (needs ExifTool and ffmpeg); see
[`test/fixtures/README.md`](test/fixtures/README.md). The offline place list is built by `scripts/build_places.mjs`.

## Deploying

`npm run build` makes a static site in `dist/` (about 48 MB, mostly models and the detection runtime). Any static
host works, also under a sub-path. Recommended host settings:

- Serve `sw.js` and `index.html` with `Cache-Control: no-cache` (everything else has content fingerprints).
- Send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so the first visit
  can already use several processor cores (the offline copy adds them by itself afterwards).
- Send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (the offline copy adds them by
  itself) so no other site can show Traceless inside a frame.

The build also writes one page per language (`/`, `/fa/`, `/tr/`) with its own title, description, links between
the languages (hreflang), sharing previews and structured data, plus `sitemap.xml`. Set `SITE_URL` to the public
address when building for another host (the Pages workflow does this). Search engines: submit
`<site>/sitemap.xml` in Google Search Console and Bing Webmaster Tools (a project site cannot have its own
`robots.txt`).

Updates: a new version is downloaded in the background, file by file (unchanged files are reused, every file is
checked against its fingerprint). Tabs that are open keep working on the version they started with; they show a
"new version ready" bar and reload only when the user taps it. The licences of the shipped third-party software are
in `THIRD_PARTY_NOTICES.txt` of every build.

## Credits and licences

Code: MIT, see [LICENSE](LICENSE). Models: see [`public/models/README.md`](public/models/README.md). Place names:
[GeoNames](https://www.geonames.org/) (CC BY 4.0) via all-the-cities. Font:
[Vazirmatn](https://github.com/rastikerdar/vazirmatn) (OFL).

By [Pouyam](https://www.pouyam.com).
