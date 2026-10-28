# ArUco Tools

Phone-first ArUco / AprilTag tools. Static site, no build step, nothing leaves the device.

- **Reader:** https://wolfffff.github.io/aruco-tools/ (live camera detection)
- **Marker sheets:** https://wolfffff.github.io/aruco-tools/generate.html (printable markers at an exact size in mm)

## Reader

- Exact OpenCV sets: `DICT_4X4/5X5/6X6/7X7` × `_50/_100/_250/_1000`, `DICT_ARUCO_ORIGINAL`, `DICT_ARUCO_MIP_36h12`, `DICT_APRILTAG_16h5/25h9/36h11`
- Detection runs in a Web Worker, once per camera frame (`requestVideoFrameCallback`)
- Auto range: alternates full-frame and 2× center passes so near and far tags both read
- Strict decoding: solid black border, minimum contrast, no ambiguous cells, exact code match; a tag must be read twice in a row before it is shown
- Optional error correction, sized to each set's real minimum distance (rotations included)
- Starts at the camera's full resolution; 1280/960/640 available for older phones
- Adaptive thresholding that cycles settings when nothing is found (dim light, big tags)
- Torch and zoom where the phone exposes them; works offline after first load; add to home screen for full screen

## Marker sheets

Pick a set, IDs (`0-11`, `3, 7, 20-24`) and the black-square size in mm, then print at 100% scale. Opens on the set the reader last used.

## Credits

Detection core: [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0 (MIT), dictionaries from OpenCV (BSD). See `vendor/LICENSE-js-aruco2.txt`.
