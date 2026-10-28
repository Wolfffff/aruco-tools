# ArUco Reader

Live ArUco / AprilTag marker reader for phones. Static site, no build step, nothing leaves the device.

**Open:** https://wolfffff.github.io/aruco-reader/

- Exact OpenCV sets: `DICT_4X4/5X5/6X6/7X7` × `_50/_100/_250/_1000`, `DICT_ARUCO_ORIGINAL`, `DICT_ARUCO_MIP_36h12`, `DICT_APRILTAG_16h5/25h9/36h11`
- Detection runs in a Web Worker, once per camera frame (`requestVideoFrameCallback`)
- Auto range: alternates full-frame and 2× center passes so near and far tags both read
- Bit-error correction sized to each set's real minimum distance (rotations included), so small sets correct more and nothing misreads
- Adaptive thresholding that cycles settings when nothing is found (dim light, big tags)
- Torch and zoom where the phone exposes them; works offline after first load; add to home screen for full screen

Detection core: [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0 (MIT), dictionaries from OpenCV (BSD). See `vendor/LICENSE-js-aruco2.txt`.
