# Security and privacy model

Pakkon is meant for people whose safety can depend on a photo not revealing where they were or who was there.
This page says plainly what it protects against, how that is checked, and where its limits are.

## What Pakkon protects against

| Risk | What Pakkon does | How it is checked |
|---|---|---|
| Hidden data in photos (GPS, phone model, serial number, owner, dates, time zone) | The picture is redrawn from its pixels into a new file; nothing from the original file is copied | Output stripped to picture data only (JPEG: SOI/DQT/SOF/DHT/DRI/SOS/EOI plus a fixed JFIF header; PNG: IHDR/PLTE/tRNS/IDAT/IEND), then re-read: any finding blocks delivery |
| Hidden thumbnails, edit history (XMP), IPTC, Content Credentials (C2PA), maker notes | Same: none of it survives a redraw | Same |
| Motion Photo / Live Photo videos, data after the end of the image ("aCropalypse") | Same: only the main picture is drawn | Same; leaky test files include both |
| Hidden data in videos (location, device tags, dates, data tracks such as GPS tracks or subtitles) | Only the main picture and sound are kept, in a newly written MP4 | The output may contain only a fixed list of MP4 boxes, known handler names, no track names, undetermined language, zeroed dates; read strictly |
| Data inside the video stream (H.264/HEVC SEI, AV1 metadata: camcorders store time, model and GPS there) | Every video is rebuilt packet by packet without these units | Every packet of the output is scanned; any unit left blocks delivery |
| Faces, licence plates, text in the picture | On-device detection; solid fills (blur can be reversed); tap to add or remove covers | Tested on a public-domain portrait, an Iranian plate and street signs; crowd recall measured on WIDER FACE |
| People identifiable by body, clothes or hair (faces turned away) | Optional covering of whole people (person detection) | Browser tests on a photo and a video |
| Moving faces in videos | Frames sampled three times a second; masks follow matched faces and are held across one missed detection | Tested on panning videos, a rotated video and a late-starting MPEG-TS file |
| Voices in videos | Optional voice change (pitch and formants lowered by a random, drifting factor; stops casual listeners, can be partly undone by someone who tries) or sound removal (the safe choice) | Pitch measured in the output in a browser test; if the browser cannot encode audio, the user chooses instead of a silent fallback |
| Needing to prove later which original a shared copy came from | Optional sealed original: the untouched file, encrypted with a passphrase (normalised for Persian/Arabic keyboards; PBKDF2-SHA-256, 600,000 rounds; AES-256-GCM). A keyed "seal code" (HMAC with a secret inside the sealed file) can be noted or published without linking anyone's copy of the original to it. It proves the file is unchanged since sealing, not that it was never edited before; the seal time is the device clock. The passphrase field is not offered to password managers; the app never stores the original | Unit and browser tests: round trip, wrong passphrase, changed file, nothing readable in the sealed file |
| Camera sensor fingerprint (PRNU) | Optional: smaller, slightly turned and trimmed picture with fresh grain | Makes matching much harder; **not** a guarantee |
| File names that reveal date/time | Output names are random | — |
| Covering silently failing | If detection or video covering fails, nothing is offered until the user covers by hand or explicitly continues | Browser tests block the models and check that no copy is offered |
| Damaged or hostile files freezing the app | Size caps, linear-time parsers, consistency checks of video sample tables | Fuzz tests with thousands of damaged files |

## Nothing leaves the device

- The page carries a Content Security Policy that only allows its own files: `connect-src 'self'` means it cannot
  send data to any other server. A browser test proves a request to another site is blocked, and every test checks
  that no request leaves the site.
- No accounts, analytics, ads, fonts or scripts from other sites. Models and the WebAssembly runtime are part of the
  app and stored for offline use.
- Pakkon keeps no copies. Settings (language and switches) are the only thing stored, in the browser's local storage.
- Files shared into Pakkon from another app (Android) are handed over in memory by the offline worker and never
  written to storage.

### Residual risk: the share target

On Android, "share to Pakkon" sends the file to the app's own address. The offline worker catches it on the
device. If the offline worker is missing (for example after site data was cleared while the installed app was
kept), that request would reach the web server hosting Pakkon. Hosting should therefore be static, with request
logging off where possible. Opening Pakkon and choosing files inside it never has this risk.

## What Pakkon cannot do

- It cannot hide what is visible: signs it did not find, landmarks, shadows, reflections, clothes, tattoos, voices.
- Detection is not perfect. The app always asks the user to check the picture and the whole video.
- It cannot remove copies already sent, or data a messenger or cloud service adds afterwards.
- A changed voice is harder to recognise for an ordinary listener, but it can be partly undone by someone who tries;
  words, accent and background sounds stay. When a voice must not be recognised, remove the sound.
- It is a web app: its safety also depends on the browser and the device being trustworthy.

## Reporting a problem

Please report anything that could leave identifying data in a "safe" copy as a security issue to the maintainers
at [pouyam.com](https://www.pouyam.com), not in a public issue.
