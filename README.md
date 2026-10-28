# ArUco Tools

Phone-first ArUco / AprilTag tools. Static site, no build step, nothing leaves the device.

- **Reader:** https://wolfffff.github.io/aruco-tools/ (live camera detection)
- **Speed test:** https://wolfffff.github.io/aruco-tools/bench.html (runs the real detector on your device)
- **Marker sheets:** https://wolfffff.github.io/aruco-tools/generate.html (printable markers at an exact size in mm)

## Reader

- Exact OpenCV sets: `DICT_4X4/5X5/6X6/7X7` × `_50/_100/_250/_1000`, `DICT_ARUCO_ORIGINAL`, `DICT_ARUCO_MIP_36h12`, `DICT_APRILTAG_16h5/25h9/36h11`
- One GPU snapshot per camera frame drives motion, the picture on screen and detection, so they always agree on the frame
- Detection in a pool of Web Workers (3, or 4 on 8+ cores); frames are skipped, never queued, when all are busy
- Focus scans: with tags in view, every other frame reads just the box around them at full camera resolution
- Latency guard shrinks the scan when a phone can't keep up, and grows it back
- Typed-array pixel core (grayscale, adaptive threshold, contour tracing) with results identical to js-aruco2
- Offline-first: opens from the phone's cache instantly, updates in the background; skips the start tap when camera access is already granted
- Track-then-verify: a confirmed tag missed by a pass (motion blur) is re-checked around its predicted position (at most 3 per frame, ~1 ms each), accepting only the same ID, and fades out over two passes; cuts flicker while moving without adding false reads
- Tags fade in and out instead of popping; labels always drawn above outlines
- Live camera with motion-compensated overlays: the picture is never held back for detection; outlines are moved by the camera motion measured since the analyzed frame (slide, zoom and twist fitted to profile shifts in a 3×3 grid of a 160 px copy, ~1 ms), so they stay on the tags while panning, zooming or turning the phone
- Auto range: alternates full-frame and 2× center passes so near and far tags both read
- Strict decoding: solid black border, minimum contrast, no ambiguous cells, exact code match; a tag must be read twice in a row before it is shown
- Optional error correction, sized to each set's real minimum distance (rotations included)
- Selectable scan size (640, 960 default, 1280, 1920, or native camera pixels)
- Re-asks the camera in other shapes when a phone returns a smaller stream than requested (common on iOS)
- Tag list puts the most recently seen tag first
- Optional 4K camera stream (Settings → More → Camera): same cost per pass, the center pass reads native pixels for roughly double the range
- Tolerates a few blurred cells while still requiring an exact code match
- Adaptive thresholding that cycles settings when nothing is found (dim light, big tags)
- Tap the picture to freeze it, tap again to resume
- Pinch to zoom: uses the camera's zoom where available, otherwise a digital zoom that also points detection at what you see
- Bottom list shows a mini drawing of each tag read, its ID, and how many times it was read; tags in view are ringed
- Uses the plain wide back lens instead of iPhone's combined camera, which hops between lenses while focusing (a visible jump); other lenses selectable in Settings → More
- Torch where the phone exposes it; works offline after first load; add to home screen for full screen

## Marker sheets

Print-ready sheets laid out in millimetres: pick a set, paper (A4 or Letter, portrait or landscape) and the black-square size, then either fill whole pages from a starting ID or list IDs (`0-11`, `3, 7, 20-24`). Optional labels and cut lines; each page has a footer and a 10 mm scale bar to check print size with a ruler. Print at 100% scale. Opens on the set the reader last used.

## Credits

Type: [Archivo](https://github.com/Omnibus-Type/Archivo) (SIL Open Font License, `fonts/OFL.txt`), stored with the app so it works offline.

Detection core: [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0 (MIT), dictionaries from OpenCV (BSD). See `vendor/LICENSE-js-aruco2.txt`.
