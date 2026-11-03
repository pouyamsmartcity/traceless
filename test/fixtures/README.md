# Test files

## `leaky/` (generated)

Made by `scripts/make_fixtures.py`. Every value in them is fake. They carry the kinds of hidden data that put people
at risk: GPS location (Azadi Square, Tehran), phone make, model and serial number, owner name, dates and time zone,
a stale embedded thumbnail, XMP edit history, IPTC city, a Content Credentials (C2PA) block, a comment, a Motion
Photo style video after the end of the JPEG, PNG text chunks and leftover bytes after the PNG end ("aCropalypse"),
and videos with location, device tags and an extra subtitle track holding GPS text.

The tests check that Pakkon reports these leaks and that the cleaned files contain none of them.

`photo-edited.jpg` carries typical signs of editing (an editor's name, a later modify date, a thumbnail of a
different shape) and `photo-honest.jpg` is an unedited photo whose thumbnail matches; they test the edit hints and
the absence of false alarms. Regenerate one group with e.g. `python3 scripts/make_fixtures.py edited`.

## `real/`

| File | Source | Licence |
|---|---|---|
| `astronaut.png` | Portrait of astronaut Eileen Collins, NASA, as shipped with [scikit-image](https://scikit-image.org/) (`skimage.data.astronaut`) | Public domain (NASA) |
| `astronaut-pan.mp4`, `astronaut-pan-rotated.mp4`, `astronaut-fast.m2ts` | Made with ffmpeg from `astronaut.png` (a slow pan, the same stored sideways with a rotation tag, and a fast pan in an MPEG-TS file whose timestamps start at about 1.5 s, like camcorder files). The x264 encoder leaves its name and settings inside the video stream, which the tests use as a stand-in for camera data. | Public domain |
| `astronaut-1080.mp4` | A 1.5-second 1920 x 1080 still video made with ffmpeg from `astronaut.png` (centred, 600 x 600) with a 330 Hz tone | Public domain |
| `astronaut-grid.jpg` | `astronaut.png` repeated 4 x 3 (a "crowd" of 12 faces) | Public domain |
| `phone-screenshot.png` | A synthetic phone screenshot (drawn with Pillow) with a dark status bar | Made for this project, public domain |
| `iran-truck.mp4` | A 2-second still video made with ffmpeg from `iran-truck.png` | MIT, as `iran-truck.png` |
| `iran-truck.png` | `files/2.png` from [barzansaeedpour/ANPR-YOLOv8](https://github.com/barzansaeedpour/ANPR-YOLOv8) (detection overlay included) | MIT, Copyright (c) Barzan Saeedpour |
