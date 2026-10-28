# ArUco Tools

Phone-first ArUco / AprilTag tools. Static site, no build step, nothing leaves the device.

- **Reader:** https://wolfffff.github.io/aruco-tools/ (live camera detection)
- **Marker sheets:** https://wolfffff.github.io/aruco-tools/generate.html (printable markers at an exact size in mm)

## Reader

- Exact OpenCV sets: `DICT_4X4/5X5/6X6/7X7` × `_50/_100/_250/_1000`, `DICT_ARUCO_ORIGINAL`, `DICT_ARUCO_MIP_36h12`, `DICT_APRILTAG_16h5/25h9/36h11`
- Detection runs in Web Workers (two on 4+ core phones), once per camera frame; frames reach the workers as GPU bitmaps so scaling and pixel readout never block the page
- Typed-array pixel core (grayscale, adaptive threshold, contour tracing) with results identical to js-aruco2
- Offline-first: opens from the phone's cache instantly, updates in the background; skips the start tap when camera access is already granted
- Track-then-verify: a confirmed tag missed by a pass (motion blur) is re-checked around its predicted position with every threshold setting, accepting only the same ID, and held for at most two passes; cuts flicker while moving without adding false reads
- Frame-synced display: the screen shows the exact frame that was analyzed, so outlines never lag or linger when the camera moves
- Auto range: alternates full-frame and 2× center passes so near and far tags both read
- Strict decoding: solid black border, minimum contrast, no ambiguous cells, exact code match; a tag must be read twice in a row before it is shown
- Optional error correction, sized to each set's real minimum distance (rotations included)
- Selectable scan size (640, 960 default, 1280, 1920, or native camera pixels)
- Re-asks the camera in other shapes when a phone returns a smaller stream than requested (common on iOS)
- Tag list puts the most recently seen tag first
- Optional 4K camera stream (Settings → More → Camera): same cost per pass, the center pass reads native pixels for roughly double the range
- Tolerates a few blurred cells while still requiring an exact code match
- Adaptive thresholding that cycles settings when nothing is found (dim light, big tags)
- Pinch to zoom: uses the camera's zoom where available, otherwise a digital zoom that also points detection at what you see
- Bottom list shows a mini drawing of each tag read, its ID, and how many times it was read; tags in view are ringed
- Uses the plain wide back lens instead of iPhone's combined camera, which hops between lenses while focusing (a visible jump); other lenses selectable in Settings → More
- Torch where the phone exposes it; works offline after first load; add to home screen for full screen

## Marker sheets

Print-ready sheets laid out in millimetres: pick a set, paper (A4 or Letter, portrait or landscape) and the black-square size, then either fill whole pages from a starting ID or list IDs (`0-11`, `3, 7, 20-24`). Optional labels and cut lines; each page has a footer and a 10 mm scale bar to check print size with a ruler. Print at 100% scale. Opens on the set the reader last used.

## Credits

Detection core: [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0 (MIT), dictionaries from OpenCV (BSD). See `vendor/LICENSE-js-aruco2.txt`.
