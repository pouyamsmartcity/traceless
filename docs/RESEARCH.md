# Competitor and leak research (2026-11-02)

Stars and release dates checked through the GitHub API on 2026-11-02.

## Bottom line
No existing tool combines: offline, runs on the phone, deep metadata cleaning, automatic face and plate masking for
photos and video, safe masking by default, and a Persian interface. The pieces exist separately: ExifCleaner and mat2
for metadata, Image Scrubber as an offline browser tool, Signal for one-tap face blur, deface/EgoBlur/DefaceIT for video.

## Competitors

| Tool | Platforms | Licence / stars | Maintained | Strengths | Gaps |
|---|---|---|---|---|---|
| [ExifCleaner](https://github.com/szTheory/exifcleaner) | Win/macOS/Linux desktop | MIT, ~2.9k | Revived 2026 (v4.7.0, 2026-10-25) | ExifTool-based, many formats, 25 languages incl. Persian | Desktop only, no masking, video GPS tracks stay |
| [mat2](https://0xacab.org/jvoisin/mat2) + Metadata Cleaner | Linux | LGPL-3.0 | v0.15.0 (2026-08) | Re-draws images, office/PDF/audio too | Linux/Python only, no masking |
| [ExifTool](https://exiftool.org/) | CLI | GPL/Artistic, 5.2k | 13.60 (2026-10) | Reads everything incl. MakerNotes, C2PA | Expert CLI; removal "not guaranteed"; cannot delete timed GPS in video |
| [Image Scrubber](https://github.com/everestpipkin/image-scrubber) | Browser | MIT, ~1.0k | Stale since 2022 | Offline in browser, EFF-recommended | Manual brush only, no video/HEIC, English only, downscales to 2500 px |
| [Signal blur](https://signal.org/blog/blur-tools) | Inside Signal | AGPL | Since 2020 | On-device auto face detection | Only inside Signal, misses faces, blur not solid, no plates/video |
| [deface](https://github.com/ORB-HD/deface) | CLI | MIT, ~1.6k | Slowing (2023 release) | Auto faces in photo and video | CLI only, no plates, weak above 720p |
| [EgoBlur](https://github.com/facebookresearch/EgoBlur) | CLI | Apache-2.0, 306 | v2.0.1 (2026-04) | Faces and plates | Research tool, heavy setup |
| [DefaceIT](https://github.com/therealaleph/DefaceIT) | Desktop + Android | No licence, 40 | 2026-01 | Faces and plates in video, voice pitch, Persian UI | Tiny, Python setup, no metadata cleaning |
| [Tella](https://tella.app/) | Android/iOS/desktop | Open source, 115 | 2026-10 | Encrypted documentation vault, Persian | Not a cleaner, no masking |
| Scrambled Exif / ExifEraser / Imagepipe | Android | GPL/MIT | Active | One-tap strip on share | Mostly JPEG, no auto masking, no video |
| ObscuraCam (Guardian Project) | Android | GPL-3 | Dead since 2021 | Was the reference tool | Abandoned |
| Metapho | iOS | Closed, paid | Active | HEIC, Live Photos, video | Paid, closed, no masking |

## Leak vectors beyond basic EXIF

| Vector | Evidence | Handling |
|---|---|---|
| Stale embedded thumbnail after crop | [RedTeam 2005-008](https://redteam-pentesting.de/en/advisories/rt-sa-2005-008) | Re-draw pixels |
| aCropalypse (cropped PNG keeps original bytes) | CVE-2023-21036, CVE-2023-28303 ([The Hacker News](https://thehackernews.com/2023/03/microsoft-issues-patch-for-acropalypse.html)) | Write a fresh file |
| MakerNotes, XMP edit history | [ExifTool FAQ](https://exiftool.org/faq.html), [Adobe xmpMM](https://developer.adobe.com/xmp/docs/XMPNamespaces/xmpMM) | Re-draw |
| Android Motion Photo, iPhone Live Photo, HEIC extra images | [Motion Photo spec](https://developer.android.com/media/platform/motion-photo-format) | Output main image only, warn |
| Video location tag and GPS tracks in the stream | [ExifTool QuickTime tags](https://exiftool.org/TagNames/QuickTime.html) | Re-package keeping only picture and sound |
| C2PA / Content Credentials (Pixel 10, Samsung, Sony, Leica, Nikon) | [Security Affairs](https://securityaffairs.com/182068/security/google-pixel-10-adds-c2pa-to-camera-and-photos-to-spot-ai-generated-or-edited-images.html) | Remove; explain it also removes authenticity proof |
| Sensor noise fingerprint (PRNU) | [AAFS 2014](https://www.aafs.org/sites/default/files/media/documents/AAFS-2014-B19.pdf) | No full fix; optional weakening, honest warning |
| File names with timestamps | (general) | Random output names |
| Landmarks, shadows, reflections | [Bellingcat](https://www.bellingcat.com/resources/2020/12/03/using-the-sun-and-the-shadows-for-geolocation/), [The Register 2019](https://www.theregister.com/2019/10/10/stalker_japan_eyes) | Checklist, optional text detection |
| Reversible blur/pixelation | [McPherson et al. 2016](https://arxiv.org/pdf/1609.00408): 83% identified in 5 guesses | Solid fill by default |
| Plates in Iran | UN Fact-Finding Mission, March 2025 ([AP](https://www.clickondetroit.com/news/world/2025/03/14/iran-increasingly-electronically-surveils-women-looking-for-headscarf-violations-un-report-warns/)) | Plate detection is a must |

## Messengers (weak evidence, must be tested ourselves)
- Telegram, WhatsApp: "photo" mode strips location; "file/document" mode sends the original with GPS.
- Signal: reported to strip on photo sends (no official statement).
- Instagram, Facebook, X: public copy stripped, but the platform receives the original.

## Gaps we can own
Phone-first offline all-in-one tool; video face/plate masking in the browser; full video metadata removal; warnings
about non-metadata leaks; safe defaults; strong Persian support; a public leak test suite.
