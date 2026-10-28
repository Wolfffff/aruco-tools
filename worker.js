// Detection runs here so the camera preview never stutters.
importScripts('vendor/cv.js', 'vendor/aruco.js');

const DICT_FILES = {
  ARUCO_4X4_1000: 'aruco_4x4_1000',
  ARUCO_5X5_1000: 'aruco_5x5_1000',
  ARUCO_6X6_1000: 'aruco_6x6_1000',
  ARUCO_7X7_1000: 'aruco_7x7_1000',
  ARUCO_DEFAULT_OPENCV: 'aruco_default_opencv',
  ARUCO_MIP_36h12: 'aruco_mip_36h12',
  APRILTAG_36h11: 'apriltag_36h11',
  APRILTAG_25h9: 'apriltag_25h9',
  APRILTAG_16h5: 'apriltag_16h5',
};

// Threshold settings tried in turn while nothing is found: small windows for small/far
// tags, larger windows and lower contrast for big tags and dim scenes.
const PASSES = [
  { kernel: 2, thresh: 7 },
  { kernel: 5, thresh: 7 },
  { kernel: 2, thresh: 4 },
  { kernel: 10, thresh: 5 },
];

const detectors = {};

// Bits of code `bits` (n×n, row-major string) rotated 90° clockwise.
function rotateBits(bits, n) {
  let out = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out += bits[(n - 1 - x) * n + y];
  return out;
}

function toWords(bits) {
  // Up to 64 bits as two 32-bit ints, for fast popcount Hamming distance.
  const hi = bits.length > 32 ? parseInt(bits.slice(0, bits.length - 32), 2) >>> 0 : 0;
  const lo = parseInt(bits.slice(-32), 2) >>> 0;
  return [hi, lo];
}

function popcount(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Minimum distance between any two codes, counting rotations, like OpenCV does.
// Only half of it (rounded down) can be corrected without risking a wrong ID.
function minDistance(codeList, n) {
  const base = codeList.map(toWords);
  const rots = codeList.map((c) => {
    const r1 = rotateBits(c, n), r2 = rotateBits(r1, n), r3 = rotateBits(r2, n);
    return [toWords(r1), toWords(r2), toWords(r3)];
  });
  let min = Infinity;
  for (let i = 0; i < base.length; i++) {
    // A code must also differ from its own rotations, or orientation is ambiguous.
    for (const r of rots[i]) {
      min = Math.min(min, popcount(base[i][0] ^ r[0]) + popcount(base[i][1] ^ r[1]));
    }
    for (let j = i + 1; j < base.length; j++) {
      const a = base[i], b = base[j];
      min = Math.min(min, popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]));
      for (const r of rots[j]) min = Math.min(min, popcount(a[0] ^ r[0]) + popcount(a[1] ^ r[1]));
    }
  }
  return min;
}

// `key` is "<library dictionary>" or "<library dictionary>:<count>" for OpenCV's
// DICT_4X4_50-style subsets, which are the first <count> codes of the 1000 set.
function getDetector(key) {
  if (detectors[key]) return detectors[key];
  const [base, countStr] = key.split(':');
  if (!AR.DICTIONARIES[base]) importScripts('vendor/dictionaries/' + DICT_FILES[base] + '.js');
  const src = AR.DICTIONARIES[base];
  if (!AR.DICTIONARIES[key]) {
    const count = countStr ? +countStr : src.codeList.length;
    AR.DICTIONARIES[key] = { nBits: src.nBits, tau: 1, codeList: src.codeList.slice(0, count) };
  }
  const det = new AR.Detector({ dictionaryName: key });
  const n = Math.sqrt(det.dictionary.nBits);
  const minDist = minDistance(det.dictionary.codeList, n);
  const correctable = Math.max(0, Math.floor((minDist - 1) / 2));
  det.dictionary.tau = correctable + 1; // the library accepts distance < tau
  det.pass = 0;
  det.misses = 0;
  detectors[key] = det;
  return det;
}

function detect(det, image, minFrac) {
  const p = PASSES[det.pass];
  CV.grayscale(image, det.grey);
  CV.adaptiveThreshold(det.grey, det.thres, p.kernel, p.thresh);
  det.contours = CV.findContours(det.thres, det.binary);
  let cands = det.findCandidates(det.contours, image.width * minFrac, 0.05, 6);
  cands = det.clockwiseCorners(cands);
  cands = det.notTooNear(cands, 6);
  return det.findMarkers(det.grey, cands, Math.max(49, det.dictionary.markSize * 10));
}

onmessage = (e) => {
  const { width, height, buffer, dict, roi } = e.data;
  const t0 = performance.now();
  let markers = [];
  let error = null;
  try {
    const det = getDetector(dict);
    const found = detect(det, { width, height, data: new Uint8ClampedArray(buffer) }, 0.01);
    // Stick with a threshold setting while it works; rotate through the others when it doesn't.
    if (found.length) det.misses = 0;
    else if (++det.misses >= 2) { det.pass = (det.pass + 1) % PASSES.length; det.misses = 0; }
    const ox = roi ? roi.x : 0, oy = roi ? roi.y : 0, s = roi ? roi.scale : 1;
    markers = found.map((m) => ({
      id: m.id,
      corners: m.corners.map((c) => [c.x / s + ox, c.y / s + oy]),
      err: m.hammingDistance,
    }));
  } catch (err) {
    error = String(err);
  }
  // Hand the pixel buffer back so the main thread can reuse it.
  postMessage({ markers, ms: performance.now() - t0, buffer, error }, [buffer]);
};
