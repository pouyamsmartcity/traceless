# Brief

Name: **Traceless** (Persian «بی‌ردپا», Turkish "İzsiz"; all three mean "without a trace"). An English name that
says what the tool does and that people find when they search; each language page carries the local name and the
words people search for in that language. (The first working name was Pakkon, "eraser"; sealed files from then still
open.)

## Goal
A free, open-source tool that makes photos and videos safe to share. It runs fully offline (nothing is uploaded),
works on phones first (installable web app) and on desktops. English is the main language; Persian and Turkish are
full translations, each with its own page for search engines. Target users: journalists, activists and ordinary people who share images of events.

## Product rules
- Offline by default. No network requests, no analytics, no accounts. Make this verifiable (visible "nothing left
  this device" indicator, CSP that forbids network, published tests).
- Safe by default: masks are solid fills, not blur (blur and pixelation are reversible, see research).
- Re-encode from pixels; never copy metadata blocks through.
- Honest: never claim "100% safe". Document what is removed and what is only weakened (camera sensor fingerprint).
- A public suite of leaky test files proves what the tool removes.

## First version (v0.1, built)
1. Re-draw images from pixels (drops EXIF, XMP, IPTC, MakerNotes, embedded thumbnails, crop leftovers, C2PA,
   Motion Photo videos), then strip the new file to picture data and re-check it before handing it over.
2. Re-package video keeping only the main picture and sound tracks (drops location, device tags, dates and data
   tracks such as GPS); creation times in the new file are zero.
3. Automatic face masking in photos (tiled, so small faces in crowds are found), with manual add/remove.
4. Automatic licence plate masking in photos, tested on Iranian plates.
5. "What did your photo reveal?" list in plain words, with the nearest town for GPS (offline GeoNames list).
6. Offline installable web app, Android share target, random output file names, Persian and English.

Added after the first pass (all tested):
7. Face and plate masking in video: frames sampled 3 times a second, masks interpolated for moving people and
   held across one missed detection, picture re-encoded as H.264, sound copied.
8. Optional text covering (signs, names, numbers; PaddleOCR detection, Apache-2.0), tap to uncover.
9. Optional extra protection against sensor-pattern (PRNU) matching: downscale, small random turn and trim, grain.
10. Pre-send checklist; error details for reports; shared originals wiped from storage; updates download only
    changed files.

Since then: voice change and voice notes, text and people covering in videos, tracking, cutting videos and
cropping photos, wipe and auto-forget, a command-line tool and an MCP server for AI agents. The README lists the
current features.

## Stack (decided)
- Web app (TypeScript, Vite), no framework, runs fully in the browser; installable (service worker, manifest).
- ONNX Runtime Web (WebAssembly) in a worker; YuNet face model (230 KB) and YOLOv9-t plate model (7.8 MB), both MIT.
  Uses several cores when cross-origin isolated (the service worker adds the headers).
- Mediabunny for video re-packaging (no re-encoding, no quality loss).
- Own binary readers for JPEG/PNG/WebP/MP4/MOV; exifr for EXIF/IPTC values.
- Strict CSP: only same-origin resources, no connections to other servers.
- Tests: Vitest (unit) and Playwright (browser, phone and desktop sizes).

Trade-offs: first visit downloads about 25 MB (runtime 14 MB, plate model 8 MB), once. A 12-megapixel crowd photo
takes about 3-5 seconds on a mid-range computer; older phones are slower. iPhones before iOS 16.4 cannot run the
detector (no WebAssembly SIMD); cleaning still works and the user is asked to cover faces by hand.

## Later ideas
Voice change in video; counting people in a crowd photo for reporting (needs a crowd-density model; a face count is already shown, which is
only a lower bound); face and plate masking in video; Text/sign detection; "everyone except this person"; screenshot mode (status bar, chat names and avatars); voice
change in video; pre-save checklist (skyline, shadows, reflections); messenger "send as file" warning; optional
sensor-fingerprint weakening; single-file offline HTML that can be passed around during internet shutdowns;
private sealed original with hash and timestamp for later proof of authenticity; Live Photo / Motion Photo handling.

## Out of scope (on purpose)
Sharpening or "reading" blurry licence plates or faces. AI enhancement invents detail that is not in the picture,
so it can produce a wrong plate number that points at an innocent person, and it is a surveillance capability: the
opposite of what this tool is for.

## Repository rules
- Commit as `Pouyam dev team <pouyamworld@gmail.com>`. No AI co-author trailers or "generated with" lines anywhere.
- Private until the owner approves the name and the first version.
