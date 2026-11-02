# Pakkon · پاک‌کن

Make a photo or video safe to share, in one step, fully offline. Pakkon removes what can reveal where, when and with
which device a picture was taken, and covers faces and licence plates with solid colour.

*Pakkon* (پاک‌کن) is Persian for "eraser".

- **Offline.** Everything runs on your phone or computer. The page is not allowed to contact any server (strict
  Content Security Policy), there are no accounts and no analytics. After the first visit it works without internet.
- **Rebuilt from pixels.** Photos are redrawn into a brand-new file. Location, phone model, serial numbers, owner
  name, dates, hidden thumbnails, edit history, Content Credentials (C2PA), Motion Photo videos and leftovers of
  cropped screenshots stay behind. The new file is checked again before you get it.
- **Faces and plates covered, in photos and videos.** On-device detection finds faces (also small faces in crowds)
  and licence plates, including Iranian plates. Covers are solid fills, because blur and pixelation can sometimes be
  reversed, drawn in clean shapes: ovals for faces, rounded shapes for plates and text, and each person's own
  silhouette (found by a segmentation network) when whole people are covered. Three looks: "smart" (a colour taken
  from around the cover, so it sits naturally in the picture), black, and Pakkon's green with its eraser mark. You can add or remove covers by hand. In videos, every frame is covered, following moving people.
- **Whole people covered on request** (body, clothes, hair), for when clothes or hair could identify someone
  (YOLOX-nano person detection, Apache-2.0).
- **Text covered on request.** Street and shop signs, names and numbers (Persian and Latin script) can be covered
  too; tap a cover to keep a piece of text visible.
- **Extra protection on request.** Makes it much harder to link a photo to a camera through its sensor's noise
  pattern (smaller, very slightly turned and trimmed picture, fresh grain).
- **Change voices or remove the sound** in videos on request (voices and background sounds can identify people
  and places). Voices are made deeper by a random, slowly drifting factor: this stops casual listeners, not someone who works to undo it; words and accents stay. Removing the sound is the safe choice.
- **Seal the original** (optional): lock the untouched original with a passphrase and record its fingerprint, to
  prove one day that a shared photo is real, without ever sharing the original. Open a `.pakkon` file in Pakkon to
  check it.
- **Take photos inside Pakkon** on phones, so the original never lands in the gallery.
- **Warnings and hints:** "this photo may show where it was taken" when signs, writing or plates stay uncovered;
  "at least N people are visible" for crowds; and for photos you receive, signs of editing (editor name, changed
  dates, a hidden thumbnail that shows a different or uncropped picture), as hints, never proof.
- **Fails safe.** If finding faces or covering a video fails, no copy is offered until you cover things by hand or
  explicitly continue without covering. Every output is checked again before you get it.
- **A checklist before sending** for what software cannot judge: reflections, signs, tattoos, shadows, voices.
- **"What did this file reveal?"** Before cleaning, Pakkon lists in plain words what the file was giving away, and
  shows the nearest town for a GPS location (from an offline list).
- **Videos.** Rebuilt into a fresh MP4 with only picture and sound; location, device tags, dates, track names, extra
  data tracks (such as GPS tracks) and metadata inside the video stream itself (camcorders store time, model and GPS
  there) are dropped. With covering on, the picture is re-encoded with covers on every frame;
  with covering off, picture and sound are copied without quality loss. Devices that cannot re-encode video still get
  the hidden data removed, with a clear warning that faces were not covered.
- **Persian first**, English too. Random output file names. Installable on Android, iPhone and desktop; on Android
  you can share photos straight into Pakkon from the gallery.

## What Pakkon cannot do

Pakkon never claims a file is "100% safe". It does not hide:

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
  model from [open-image-models](https://github.com/ankandrew/open-image-models). See
  [`public/models/README.md`](public/models/README.md) for sources, licences and checksums.
- Video: [Mediabunny](https://mediabunny.dev/) re-packages the file; our own reader checks the result.
- Offline: a service worker stores the whole app (about 25 MB, once).

## Development

Requires Node.js 22.

```bash
npm install
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

## Credits and licences

Code: MIT, see [LICENSE](LICENSE). Models: see [`public/models/README.md`](public/models/README.md). Place names:
[GeoNames](https://www.geonames.org/) (CC BY 4.0) via all-the-cities. Font:
[Vazirmatn](https://github.com/rastikerdar/vazirmatn) (OFL).

By [Pouyam](https://www.pouyam.com).
