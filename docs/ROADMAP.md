# Ideas for the next versions

Twenty ideas, grouped by how well they fit Pakkon's purpose: protecting the people in and behind a photo or video.
Each needs the same treatment as v0.1: tests with real and hostile files, and honest limits in the interface.

## A. Stronger protection (fits Pakkon directly)

1. **Voice disguise in videos.** Pitch and formant shift that keeps speech understandable, as an alternative to
   removing the sound. Must be tested against simple reversal (a fixed pitch shift can be undone).
2. **Text covering in videos.** Run the text detector on sampled frames, like faces and plates.
3. **Smarter screenshot mode.** Find chat names, profile pictures and phone numbers in messenger screenshots and
   cover those, keeping the message itself readable.
4. **Reflection warning.** Detect mirrors, windows and glasses where a face or the photographer may be reflected.
5. **Location risk score.** Combine what was found (signs, plates, skyline, shop fronts) into a plain warning:
   "this photo may show where it was taken".
6. **Shadow and sky warning.** Explain when long, sharp shadows could reveal the time of day and direction.
7. **iPhone "share to Pakkon".** iOS has no web share target; an Apple Shortcut could pass photos to the app.
8. **Android app package.** A small wrapper (Trusted Web Activity) for people who cannot reach the website.
9. **Offline sharing during shutdowns.** A single file or package that can be passed by Bluetooth or USB.
10. **Take the photo inside Pakkon.** Camera mode whose pictures never carry location or device data at all.
11. **More languages of Iran.** Kurdish, Azerbaijani Turkish, Baluchi and Arabic, reviewed by native speakers.
12. **Sealed original.** Keep the untouched original encrypted on the device with a hash and time stamp, so an
    authentic version can be proven later without ever sharing it.

## B. Verification tools for journalists (defensive, could be a "Check" mode)

13. **"What does a received file claim?"** A report of the device, time and place a file says it was made, to check
    a source's story. Read-only; reuses the existing inspector.
14. **Edit hints.** Signs that a photo was edited or re-saved (software tags, double compression, broken Content
    Credentials), always shown as hints, never as proof.
15. **Sun and shadow calculator.** Check whether shadows fit the claimed time and place.
16. **Old-photo check.** Compare a "new" photo against the user's own archive (perceptual hashes, offline) to
    catch recycled images.
17. **Crowd size estimate.** A range for how many people are in a protest photo, for reporting. It counts, it does
    not identify anyone.
18. **Long video overview.** Key frames and scene changes so a long recording can be reviewed quickly.

## C. Own-footage evidence (only as a separate tool, with limits)

19. **Dashcam/CCTV event finder.** In footage the user owns (for example a theft or a hit-and-run), find the
    moments when vehicles pass and show the sharpest real frame of each plate area. No "enhancement": the tool
    shows only pixels that exist.
20. **Chain of custody.** Hashes and an unaltered copy of the original footage, so evidence can be handed to a
    lawyer or court without doubt about tampering.

## Out of scope, on purpose

- **Identifying or searching for a specific person** in crowds or long videos (face recognition, re-identification,
  tracking people across cameras). This is the core of surveillance and would be used first against the people
  Pakkon is meant to protect.
- **AI "enhancement" of blurry plates or faces.** It invents detail that is not in the picture and can point at an
  innocent person.
- **Reading plates in other people's footage** or matching them against databases.
