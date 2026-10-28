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
  det.correctable = Math.max(0, Math.floor((minDistance(det.dictionary.codeList, n) - 1) / 2));
  det.pass = 0;
  det.misses = 0;
  detectors[key] = det;
  return det;
}

// Decoding works on a perspective-corrected copy of the candidate with whole-pixel
// cells, sampling only each cell's middle so blur at cell edges does not vote.
const CELL = 8;
const MARGIN = 2;
const MIN_CONTRAST = 45; // grey levels between darkest and brightest pixel in the candidate

function decode(det, candidate, maxErrors) {
  const n = det.dictionary.markSize; // cells across, black border included
  const size = n * CELL;
  const img = CV.warp(det.grey, det.homography, candidate, size);
  const d = img.data;
  const len = size * size;

  let lo = 255, hi = 0;
  for (let i = 0; i < len; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < MIN_CONTRAST) return null;
  const t = CV.otsu(img);

  const white = (cx, cy) => {
    let c = 0, tot = 0;
    for (let y = cy * CELL + MARGIN; y < (cy + 1) * CELL - MARGIN; y++) {
      for (let x = cx * CELL + MARGIN; x < (cx + 1) * CELL - MARGIN; x++, tot++) if (d[y * size + x] > t) c++;
    }
    return c / tot;
  };

  // The border must be solid black: real tags have it, most random quads do not.
  let borderWhite = 0, cells = 0;
  for (let i = 0; i < n; i++) {
    for (const [cx, cy] of [[i, 0], [i, n - 1], [0, i], [n - 1, i]]) {
      const w = white(cx, cy);
      if (w > 0.35) return null;
      borderWhite += w; cells++;
    }
  }
  if (borderWhite / cells > 0.08) return null;

  // Every data cell has to be clearly black or clearly white.
  const bits = [];
  let unsure = 0, ones = 0;
  for (let y = 1; y < n - 1; y++) {
    const row = [];
    for (let x = 1; x < n - 1; x++) {
      const w = white(x, y);
      if (w > 0.25 && w < 0.75) unsure++;
      const b = w >= 0.5 ? 1 : 0;
      ones += b;
      row.push(b);
    }
    bits.push(row);
  }
  // Blur leaves a few in-between cells on real tags. Tolerate a handful, but only when
  // the rest of the code then matches exactly (or within the chosen correction).
  const blurAllowance = Math.max(1, Math.floor(det.dictionary.nBits / 8));
  if (unsure > blurAllowance + maxErrors) return null;
  if (ones === 0) return null; // an all-black square is not a tag

  let best = null, rot = 0, cur = bits;
  for (let r = 0; r < 4; r++) {
    const f = det.dictionary.find(cur);
    if (f && f.distance <= maxErrors && (!best || f.distance < best.distance)) {
      best = f; rot = r;
      if (f.distance === 0) break;
    }
    cur = det.rotate(cur);
  }
  if (!best) return null;
  return { id: best.id, corners: det.rotate2(candidate, 4 - rot), err: best.distance };
}

// Reject quads that are tiny or very skewed: they decode badly and cause most false reads.
function plausible(q) {
  let min = Infinity, max = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const l = Math.hypot(a.x - b.x, a.y - b.y);
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return min >= 10 && max / min < 3.5;
}

function detect(det, image, maxErrors) {
  const p = PASSES[det.pass];
  CV.grayscale(image, det.grey);
  CV.adaptiveThreshold(det.grey, det.thres, p.kernel, p.thresh);
  det.contours = CV.findContours(det.thres, det.binary);
  let cands = det.findCandidates(det.contours, image.width * 0.01, 0.05, 10);
  cands = det.clockwiseCorners(cands).filter(plausible);
  cands = det.notTooNear(cands, 6);
  det.dictionary.tau = maxErrors + 1; // dictionary.find accepts distance < tau
  const out = [];
  for (const c of cands) {
    const m = decode(det, c, maxErrors);
    if (!m) continue;
    // One physical tag can yield nested contours; keep one read per tag, but allow
    // several printed copies of the same ID in view.
    const cx = (m.corners[0].x + m.corners[2].x) / 2, cy = (m.corners[0].y + m.corners[2].y) / 2;
    const dup = out.some((o) => o.id === m.id && Math.hypot(o.cx - cx, o.cy - cy) < Math.hypot(m.corners[0].x - m.corners[2].x, m.corners[0].y - m.corners[2].y) / 2);
    if (!dup) out.push(Object.assign(m, { cx, cy }));
  }
  return out;
}

onmessage = (e) => {
  const { width, height, buffer, dict, roi, correct } = e.data;
  const t0 = performance.now();
  let markers = [];
  let error = null;
  try {
    const det = getDetector(dict);
    const maxErrors = correct ? det.correctable : 0;
    const found = detect(det, { width, height, data: new Uint8ClampedArray(buffer) }, maxErrors);
    // Stick with a threshold setting while it works; rotate through the others when it doesn't.
    if (found.length) det.misses = 0;
    else if (++det.misses >= 2) { det.pass = (det.pass + 1) % PASSES.length; det.misses = 0; }
    const ox = roi ? roi.x : 0, oy = roi ? roi.y : 0, s = roi ? roi.scale : 1;
    markers = found.map((m) => ({
      id: m.id,
      corners: m.corners.map((c) => [c.x / s + ox, c.y / s + oy]),
      err: m.err,
    }));
  } catch (err) {
    error = String(err);
  }
  // Hand the pixel buffer back so the main thread can reuse it.
  postMessage({ markers, ms: performance.now() - t0, buffer, error }, [buffer]);
};
