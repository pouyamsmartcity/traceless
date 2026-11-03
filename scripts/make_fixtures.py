#!/usr/bin/env python3
"""Generate the public suite of "leaky" test files in test/fixtures/leaky.

Every file carries fake but realistic identifying data (location, device, owner, time, hidden extra images).
The tests prove that Pakkon finds these leaks and that the cleaned output no longer contains them.

Requirements (only for regenerating; the generated files are committed):
  - Python 3 with Pillow
  - ExifTool 13+ on PATH, or EXIFTOOL=/path/to/exiftool
  - ffmpeg on PATH

All values are fake. Coordinates point to Azadi Square, Tehran (a public landmark).
"""
import io
import os
import shutil
import struct
import subprocess
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'test', 'fixtures', 'leaky')
EXIFTOOL = os.environ.get('EXIFTOOL') or shutil.which('exiftool')
LAT, LON = 35.6997, 51.3380

COMMON_TAGS = [
    f'-GPSLatitude={LAT}', '-GPSLatitudeRef=N', f'-GPSLongitude={LON}', '-GPSLongitudeRef=E',
    '-GPSAltitude=1190', '-GPSAltitudeRef=0',
    '-Make=FakePhone Co', '-Model=FakePhone 15 Pro', '-SerialNumber=FP-SN-0042',
    '-LensModel=FakePhone back camera 6.8mm', '-Software=FakeCam 3.1',
    '-DateTimeOriginal=2026:09:21 18:30:00', '-OffsetTimeOriginal=+03:30',
    '-Artist=Jane Reporter', '-Copyright=Jane Reporter', '-OwnerName=Jane Reporter',
    '-ImageUniqueID=5f1e2d3c4b5a69788796a5b4c3d2e1f0',
    '-XMP-photoshop:City=Tehran', '-XMP-photoshop:Country=Iran',
    '-XMP-xmpMM:DocumentID=xmp.did:0042', '-XMP-xmpMM:OriginalDocumentID=xmp.did:original-0042',
    '-XMP-dc:Creator=Jane Reporter',
]


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)


def scene(w, h, seed_color):
    """A simple synthetic scene with shapes so the image is not uniform."""
    img = Image.new('RGB', (w, h), seed_color)
    d = ImageDraw.Draw(img)
    for i in range(0, w, 40):
        d.line([(i, 0), (w - i, h)], fill=(255 - i % 255, 120, i % 255), width=3)
    d.rectangle([w // 4, h // 4, w // 2, h // 2], fill=(20, 160, 60))
    d.ellipse([w // 2, h // 3, w - 20, h - 20], fill=(30, 60, 200))
    # A mark in the top-left corner so tests can check orientation was applied.
    d.rectangle([0, 0, w // 8, h // 8], fill=(255, 0, 0))
    return img


def jumbf_c2pa_app11():
    """A minimal JUMBF superbox labelled 'c2pa' in an APP11 segment, like Content Credentials."""
    c2pa_uuid = b'c2pa' + bytes.fromhex('00110010800000aa00389b71')
    label = b'c2pa\x00'
    jumd_payload = c2pa_uuid + b'\x03' + label
    jumd = struct.pack('>I', 8 + len(jumd_payload)) + b'jumd' + jumd_payload
    claim = b'{"claim_generator":"FakeCam/3.1","signature":"fake","assertions":["stds.exif"]}'
    json_box = struct.pack('>I', 8 + len(claim)) + b'json' + claim
    jumb = struct.pack('>I', 8 + len(jumd) + len(json_box)) + b'jumb' + jumd + json_box
    payload = b'JP' + struct.pack('>H', 1) + struct.pack('>I', 1) + jumb
    return b'\xff\xeb' + struct.pack('>H', 2 + len(payload)) + payload


def insert_after_soi(data, segment):
    assert data[:2] == b'\xff\xd8'
    return data[:2] + segment + data[2:]


def make_jpeg():
    path = os.path.join(OUT, 'photo-everything.jpg')
    scene(800, 600, (200, 200, 180)).save(path, quality=90)
    thumb = os.path.join(OUT, '_thumb.jpg')
    # The embedded thumbnail deliberately shows a different picture, like a stale thumbnail after a crop.
    scene(160, 120, (250, 10, 200)).save(thumb, quality=80)
    run([EXIFTOOL, '-q', '-overwrite_original', *COMMON_TAGS,
         '-Orientation#=6',  # rotate 90 degrees clockwise when displayed
         f'-ThumbnailImage<={thumb}',
         '-IPTC:City=Tehran', '-IPTC:By-line=Jane Reporter', '-IPTC:Keywords=protest',
         '-Comment=sent from my secret phone',
         '-XMP-GCamera:MicroVideo=1', '-XMP-GCamera:MicroVideoOffset=64',
         path])
    os.remove(thumb)
    with open(path, 'rb') as f:
        data = f.read()
    data = insert_after_soi(data, jumbf_c2pa_app11())
    # Motion Photo style: a short video appended after the end of the JPEG.
    data += b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom' + b'\x00' * 40
    with open(path, 'wb') as f:
        f.write(data)


def make_png():
    path = os.path.join(OUT, 'screenshot-leaky.png')
    scene(400, 300, (240, 240, 240)).save(path)
    run([EXIFTOOL, '-q', '-overwrite_original', *COMMON_TAGS, '-PNG:Comment=chat with source', path])
    with open(path, 'rb') as f:
        data = f.read()
    # aCropalypse style: leftover bytes of a bigger image after IEND.
    data += b'\x00' * 16 + b'IDATleftover-from-the-uncropped-screenshot' * 4
    with open(path, 'wb') as f:
        f.write(data)


def make_webp():
    path = os.path.join(OUT, 'photo-leaky.webp')
    scene(400, 300, (180, 200, 220)).save(path, quality=85)
    run([EXIFTOOL, '-q', '-overwrite_original', *COMMON_TAGS, path])


def make_edited():
    """A photo that carries typical signs of editing: an editor's name, a later modify date, and a picture that
    was cropped after the thumbnail was made (the thumbnail still shows the whole scene)."""
    path = os.path.join(OUT, 'photo-edited.jpg')
    whole = scene(1600, 1200, (210, 190, 170))
    whole.crop((800, 300, 1600, 900)).save(path, quality=90)
    thumb = os.path.join(OUT, '_thumb_whole.jpg')
    whole.resize((160, 120)).save(thumb, quality=80)
    run([EXIFTOOL, '-q', '-overwrite_original', '-Make=FakePhone Co', '-Model=FakePhone 15 Pro',
         '-DateTimeOriginal=2026:09:21 18:30:00', '-ModifyDate=2026:10:02 09:15:00',
         '-Software=Adobe Photoshop 27.0 (Windows)', f'-ThumbnailImage<={thumb}', path])
    os.remove(thumb)


def make_honest():
    """An unedited camera-style photo whose thumbnail matches the picture (no edit hints expected)."""
    path = os.path.join(OUT, 'photo-honest.jpg')
    img = scene(800, 600, (120, 160, 200))
    img.save(path, quality=90)
    thumb = os.path.join(OUT, '_thumb_same.jpg')
    img.resize((160, 120)).save(thumb, quality=80)
    run([EXIFTOOL, '-q', '-overwrite_original', '-Make=FakePhone Co', '-Model=FakePhone 15 Pro',
         '-DateTimeOriginal=2026:09:21 18:30:00', '-ModifyDate=2026:09:21 18:30:00', '-Software=FakeCam 3.1',
         f'-ThumbnailImage<={thumb}', path])
    os.remove(thumb)
    # Wide (16:9) photos whose 4:3 thumbnail has black bars, or is centre-cropped, as cameras make them,
    # and a mirrored photo (orientation 2): none of them may raise an edit hint.
    wide = scene(1280, 720, (100, 180, 120))
    for name, make_thumb, extra in (
        ('photo-honest-wide-bars.jpg', lambda im: letterbox(im, 160, 120), []),
        ('photo-honest-wide-crop.jpg', lambda im: im.crop((160, 0, 1120, 720)).resize((160, 120)), []),
        ('photo-honest-mirrored.jpg', lambda im: im.resize((160, 90)), ['-Orientation#=2']),
    ):
        path = os.path.join(OUT, name)
        wide.save(path, quality=90)
        thumb = os.path.join(OUT, '_thumb_wide.jpg')
        make_thumb(wide).save(thumb, quality=80)
        run([EXIFTOOL, '-q', '-overwrite_original', '-Make=FakePhone Co', '-Model=FakePhone 15 Pro',
             '-DateTimeOriginal=2026:09:21 18:30:00', *extra, f'-ThumbnailImage<={thumb}', path])
        os.remove(thumb)


def letterbox(im, w, h):
    """Fits `im` into w x h with black bars."""
    r = min(w / im.width, h / im.height)
    small = im.resize((round(im.width * r), round(im.height * r)))
    out = Image.new('RGB', (w, h), (0, 0, 0))
    out.paste(small, ((w - small.width) // 2, (h - small.height) // 2))
    return out


def make_videos():
    base = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2']
    srt = os.path.join(OUT, '_gps.srt')
    with open(srt, 'w') as f:
        f.write('1\n00:00:00,000 --> 00:00:02,000\nGPS 35.6997 51.3380 ALT 1190\n')
    tags = ['-metadata', f'location=+{LAT:.4f}+{LON:08.4f}/', '-metadata', 'creation_time=2026-09-21T15:00:00Z',
            '-metadata', 'make=FakePhone Co', '-metadata', 'model=FakePhone 15 Pro',
            '-metadata', 'com.apple.quicktime.location.ISO6709=' + f'+{LAT:.4f}+{LON:08.4f}+1190.000/',
            '-metadata', 'com.apple.quicktime.make=FakePhone Co',
            '-metadata', 'com.apple.quicktime.model=FakePhone 15 Pro',
            '-metadata', 'com.apple.quicktime.software=FakeCam 3.1',
            '-metadata', 'com.apple.quicktime.creationdate=2026-09-21T18:30:00+0330']
    for name, extra in (('video-location.mp4', ['-movflags', '+use_metadata_tags']),
                        ('video-location.mov', [])):
        out = os.path.join(OUT, name)
        run(base + ['-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '30',
                    '-c:a', 'aac', '-b:a', '64k', '-c:s', 'mov_text', *tags, *extra, out])
    os.remove(srt)
    # A phone held upright: the picture is stored sideways with a "rotate 90" display instruction.
    plain = os.path.join(OUT, '_plain.mp4')
    run(base + ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac',
                '-b:a', '64k', plain])
    run(['ffmpeg', '-v', 'error', '-y', '-display_rotation', '90', '-i', plain, '-c', 'copy',
         os.path.join(OUT, 'video-rotated.mp4')])
    os.remove(plain)


def make_audio():
    """Voice notes with the tags phones and messengers write: place-named title, speaker, date, place, app, cover."""
    tone = ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=2:sample_rate=48000']
    cover = os.path.join(OUT, '_cover.png')
    scene(64, 64, (200, 80, 60)).save(cover)
    tags = ['-metadata', 'title=Enghelab Square 3', '-metadata', 'artist=Reza Example',
            '-metadata', 'date=2026-09-21T18:30:00', '-metadata', 'comment=recorded near the bazaar',
            '-metadata', 'encoder=FakeRecorder 2.0']
    run(['ffmpeg', '-v', 'error', '-y', *tone, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-b:a', '64k',
         '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', *tags,
         '-metadata', 'location=' + f'+{LAT:.4f}+{LON:08.4f}/',
         '-metadata', 'com.apple.quicktime.location.ISO6709=' + f'+{LAT:.4f}+{LON:08.4f}+1190.000/',
         '-movflags', '+use_metadata_tags', os.path.join(OUT, 'voice-memo.m4a')])
    run(['ffmpeg', '-v', 'error', '-y', *tone, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame',
         '-b:a', '64k', '-c:v', 'png', '-disposition:v', 'attached_pic', '-id3v2_version', '3', *tags,
         os.path.join(OUT, 'voice-note.mp3')])
    run(['ffmpeg', '-v', 'error', '-y', *tone, '-c:a', 'libopus', '-b:a', '32k', *tags,
         os.path.join(OUT, 'voice-note.ogg')])
    # A voice note saved as an .mp4 "video" that holds only sound (some recorders and browsers do this).
    run(['ffmpeg', '-v', 'error', '-y', *tone, '-c:a', 'aac', '-b:a', '48k', *tags,
         os.path.join(OUT, 'voice-only.mp4')])
    os.remove(cover)


def main():
    if not EXIFTOOL:
        sys.exit('ExifTool not found. Install it or set EXIFTOOL=/path/to/exiftool')
    os.makedirs(OUT, exist_ok=True)
    only = sys.argv[1:]
    for name, fn in (('jpeg', make_jpeg), ('png', make_png), ('webp', make_webp), ('edited', make_edited), ('honest', make_honest), ('videos', make_videos), ('audio', make_audio)):
        if not only or name in only:
            fn()
    print('Fixtures written to', OUT)


if __name__ == '__main__':
    main()
