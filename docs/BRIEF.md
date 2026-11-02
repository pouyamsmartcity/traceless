# Brief

## Goal
A free, open-source tool that makes photos and videos safe to share. It runs fully offline (nothing is uploaded),
works on phones first (installable web app) and on desktops, and is Persian-first with other languages of Iran and
English. Target users: journalists, activists and ordinary people who share images of events.

## Product rules
- Offline by default. No network requests, no analytics, no accounts. Make this verifiable (visible "nothing left
  this device" indicator, CSP that forbids network, published tests).
- Safe by default: masks are solid fills, not blur (blur and pixelation are reversible, see research).
- Re-encode from pixels; never copy metadata blocks through.
- Honest: never claim "100% safe". Document what is removed and what is only weakened (camera sensor fingerprint).
- A public suite of leaky test files proves what the tool removes.

## Candidate first version (to be confirmed with the owner)
1. Re-draw images from pixels (drops EXIF, XMP, IPTC, MakerNotes, embedded thumbnails, crop leftovers, C2PA).
2. Re-package video keeping only picture and sound (drops GPS tracks inside the stream).
3. Automatic face detection and masking in photos and video, with manual add/remove.
4. Automatic licence plate detection, including Iranian plates with Persian digits.
5. "What does your photo reveal?" view: shows on a map and in plain words what the file leaks before cleaning.
6. Offline installable web app, share-target on phones, random output file names.

## Later ideas
Text/sign detection; "everyone except this person"; screenshot mode (status bar, chat names and avatars); voice
change in video; pre-save checklist (skyline, shadows, reflections); messenger "send as file" warning; optional
sensor-fingerprint weakening; single-file offline HTML that can be passed around during internet shutdowns;
private sealed original with hash and timestamp for later proof of authenticity; Live Photo / Motion Photo handling.

## Repository rules
- Commit as `Pouyam dev team <pouyamworld@gmail.com>`. No AI co-author trailers or "generated with" lines anywhere.
- Private until the owner approves the name and the first version.
