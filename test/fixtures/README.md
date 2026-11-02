# Test files

## `leaky/` (generated)

Made by `scripts/make_fixtures.py`. Every value in them is fake. They carry the kinds of hidden data that put people
at risk: GPS location (Azadi Square, Tehran), phone make, model and serial number, owner name, dates and time zone,
a stale embedded thumbnail, XMP edit history, IPTC city, a Content Credentials (C2PA) block, a comment, a Motion
Photo style video after the end of the JPEG, PNG text chunks and leftover bytes after the PNG end ("aCropalypse"),
and videos with location, device tags and an extra subtitle track holding GPS text.

The tests check that Pakkon reports these leaks and that the cleaned files contain none of them.

## `real/`

| File | Source | Licence |
|---|---|---|
| `astronaut.png` | Portrait of astronaut Eileen Collins, NASA, as shipped with [scikit-image](https://scikit-image.org/) (`skimage.data.astronaut`) | Public domain (NASA) |
| `iran-truck.png` | `files/2.png` from [barzansaeedpour/ANPR-YOLOv8](https://github.com/barzansaeedpour/ANPR-YOLOv8) (detection overlay included) | MIT, Copyright (c) Barzan Saeedpour |
