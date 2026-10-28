# ArUco Tools

Phone-first ArUco / AprilTag tools. Static site, no build step, nothing leaves the device.

- **Reader:** https://wolfffff.github.io/aruco-tools/ (live camera detection)
- **Marker sheets:** https://wolfffff.github.io/aruco-tools/generate.html (printable markers at an exact size in mm)

## Reader

- Exact OpenCV sets: `DICT_4X4/5X5/6X6/7X7` × `_50/_100/_250/_1000`, `DICT_ARUCO_ORIGINAL`, `DICT_ARUCO_MIP_36h12`, `DICT_APRILTAG_16h5/25h9/36h11`
- Detection runs in a Web Worker, once per camera frame (`requestVideoFrameCallback`)
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
- Torch where the phone exposes it; works offline after first load; add to home screen for full screen

## Marker sheets

Pick a set, IDs (`0-11`, `3, 7, 20-24`) and the black-square size in mm, then print at 100% scale. Opens on the set the reader last used.

## Credits

Detection core: [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0 (MIT), dictionaries from OpenCV (BSD). See `vendor/LICENSE-js-aruco2.txt`.
