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

function decode(det, candidate, maxErrors, verifying = false) {
  const n = det.dictionary.markSize; // cells across, black border included
  const size = n * CELL;
  if (det.homography.data.length !== size * size) det.homography = new CV.Image(size, size, new Uint8Array(size * size));
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
  // When re-checking a known tag (only its own ID is accepted), allow twice as many.
  const blurAllowance = Math.max(1, Math.floor(det.dictionary.nBits / (verifying ? 4 : 8)));
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

/* ---------- fast pixel core ----------
   Same algorithms as cv.js (grayscale, stack box blur + adaptive threshold, Suzuki border
   following), rewritten on typed arrays with integer math and no per-pixel objects.
   These three stages were ~85% of the time per frame. */

// `buf` is the working set the pixel functions read; it points at the whole scan, or at a
// small crop while re-checking where a known tag should be.
const scanBuf = { w: 0, h: 0 };
const roiBuf = { w: 0, h: 0 };
let buf = scanBuf;

function ensureBuffers(w, h) {
  if (buf.w === w && buf.h === h) return;
  buf.w = w; buf.h = h;
  // Grow-only and reused: the re-check crop changes size every frame.
  const n = w * h, L = (w + 2) * (h + 2);
  if (!buf.gray || buf.gray.length < n) { buf.gray = new Uint8Array(n); buf.tmp = new Uint8Array(n); }
  // The contour tracer needs a zero border around the image; with a new width the border
  // lands on different cells, so clear the part in use.
  if (!buf.labels || buf.labels.length < L) buf.labels = new Int32Array(L);
  else buf.labels.fill(0, 0, L);
  if (!buf.pts) buf.pts = new Int32Array(8192);
}

function grayscale(rgba, w, h) {
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
  const g = buf.gray;
  // 0.299 R + 0.587 G + 0.114 B in 16-bit fixed point (pixels are little-endian RGBA).
  for (let i = 0, n = w * h; i < n; i++) {
    const v = px[i];
    g[i] = ((v & 255) * 19595 + ((v >>> 8) & 255) * 38470 + ((v >>> 16) & 255) * 7471 + 32768) >>> 16;
  }
}

// Adaptive threshold: a pixel is foreground (dark) when it is at least `t` below the mean of
// its (2k+1)² neighbourhood, edges repeated. Same integer rounding as CV.stackBoxBlur, so
// results match the original library. The horizontal pass runs along rows; the vertical
// pass keeps one running sum per column and also sweeps along rows, which is far kinder
// to the CPU cache than walking down columns. The threshold is folded into that sweep.
function adaptiveThreshold(k, t) {
  const { w, h, gray: src, tmp, labels } = buf;
  const mult = CV.stackBoxBlurMult[k], shift = CV.stackBoxBlurShift[k];
  const w1 = w - 1, h1 = h - 1, W = w + 2;
  for (let y = 0, row = 0; y < h; y++, row += w) {
    let sum = (k + 1) * src[row];
    for (let i = 1; i <= k; i++) sum += src[row + (i < w1 ? i : w1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum * mult) >>> shift;
      const add = x + k + 1, sub = x - k;
      sum += src[row + (add < w1 ? add : w1)] - src[row + (sub > 0 ? sub : 0)];
    }
  }
  const col = buf.col && buf.col.length === w ? buf.col : (buf.col = new Int32Array(w));
  for (let x = 0; x < w; x++) col[x] = (k + 1) * tmp[x];
  for (let i = 1; i <= k; i++) { const r = (i < h1 ? i : h1) * w; for (let x = 0; x < w; x++) col[x] += tmp[r + x]; }
  for (let y = 0; y < h; y++) {
    const row = y * w, out = (y + 1) * W + 1;
    const addRow = (y + k + 1 < h1 ? y + k + 1 : h1) * w, subRow = (y - k > 0 ? y - k : 0) * w;
    for (let x = 0; x < w; x++) {
      labels[out + x] = src[row + x] - ((col[x] * mult) >>> shift) <= -t ? 1 : 0;
      col[x] += tmp[addRow + x] - tmp[subRow + x];
    }
  }
}

const NB = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

// Suzuki-Abe border following, as CV.findContours. Points go into a reusable flat buffer;
// only contours with at least `minLen` points become arrays of {x, y}, since only those
// can be tags. Everything else (thousands of specks per frame) costs no allocation.
function findContours(minLen) {
  const { w, h, labels: src } = buf;
  const W = w + 2;
  const deltas = new Int32Array(16);
  for (let i = 0; i < 8; i++) deltas[i] = deltas[i + 8] = NB[i][0] + NB[i][1] * W;
  const contours = [];
  let pts = buf.pts;
  let nbd = 1;
  let pos = W + 1;
  for (let i = 0; i < h; i++, pos += 2) {
    for (let j = 0; j < w; j++, pos++) {
      const pix = src[pos];
      if (pix === 0) continue;
      let hole = false;
      if (pix === 1 && src[pos - 1] === 0) hole = false;
      else if (pix >= 1 && src[pos + 1] === 0) hole = true;
      else continue;
      nbd++;
      // borderFollowing
      let n = 0;
      let px = j, py = i;
      let s = hole ? 0 : 4, sEnd = s, pos1;
      do {
        s = (s - 1) & 7;
        pos1 = pos + deltas[s];
        if (src[pos1] !== 0) break;
      } while (s !== sEnd);
      if (s === sEnd) {
        src[pos] = -nbd;
        pts[0] = px; pts[1] = py; n = 1;
      } else {
        let pos3 = pos, pos4;
        for (;;) {
          sEnd = s;
          do { pos4 = pos3 + deltas[++s]; } while (src[pos4] === 0);
          s &= 7;
          if (((s - 1) >>> 0) < (sEnd >>> 0)) src[pos3] = -nbd;
          else if (src[pos3] === 1) src[pos3] = nbd;
          if (2 * n + 2 > pts.length) { const bigger = new Int32Array(pts.length * 2); bigger.set(pts); pts = buf.pts = bigger; }
          pts[2 * n] = px; pts[2 * n + 1] = py; n++;
          px += NB[s][0]; py += NB[s][1];
          if (pos4 === pos && pos3 === pos1) break;
          pos3 = pos4;
          s = (s + 4) & 7;
        }
      }
      if (n >= minLen) {
        const c = new Array(n);
        for (let k = 0; k < n; k++) c[k] = { x: pts[2 * k], y: pts[2 * k + 1] };
        c.hole = hole;
        contours.push(c);
      }
    }
  }
  return contours;
}

// Track-then-verify: a tag seen in recent frames that the full scan missed (usually
// motion blur) is looked for again in a small area around where it should be, trying
// every threshold setting and allowing error correction. Only the same ID is accepted,
// which is far safer than detecting from scratch, so this cannot add false reads.
function verifyExpected(det, expect, found, w, h) {
  const out = [];
  for (const e of expect) {
    const xs = e.corners.map((c) => c[0]), ys = e.corners.map((c) => c[1]);
    const cx = (xs[0] + xs[1] + xs[2] + xs[3]) / 4, cy = (ys[0] + ys[1] + ys[2] + ys[3]) / 4;
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (found.some((m) => m.id === e.id && Math.hypot(m.cx - cx, m.cy - cy) < size)) continue;
    const pad = Math.max(12, size * 0.45);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const x1 = Math.min(w, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(h, Math.ceil(Math.max(...ys) + pad));
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 16 || rh < 16) continue;
    // Copy the crop of the scan's grayscale into the small working set.
    const full = scanBuf.gray;
    buf = roiBuf;
    ensureBuffers(rw, rh);
    for (let y = 0; y < rh; y++) buf.gray.set(full.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + rw), y * rw);
    const grey = det.grey;
    det.grey = new CV.Image(rw, rh, buf.gray);
    det.dictionary.tau = det.correctable + 1;
    let hit = null;
    for (const p of PASSES) {
      adaptiveThreshold(p.kernel, p.thresh);
      let cands = det.findCandidates(findContours(8), 8, 0.05, 8);
      cands = det.clockwiseCorners(cands).filter(plausible);
      for (const c of cands) {
        const m = decode(det, c, det.correctable, true);
        if (m && m.id === e.id) { hit = m; break; }
      }
      if (hit) break;
    }
    det.grey = grey;
    buf = scanBuf;
    if (hit) {
      hit.corners = hit.corners.map((c) => ({ x: c.x + x0, y: c.y + y0 }));
      hit.cx = (hit.corners[0].x + hit.corners[2].x) / 2;
      hit.cy = (hit.corners[0].y + hit.corners[2].y) / 2;
      hit.verified = true;
      out.push(hit);
    }
  }
  return out;
}

function detect(det, rgba, w, h, maxErrors, timings) {
  const p = PASSES[det.pass];
  let t = performance.now();
  const lap = (k) => { if (timings) { const n = performance.now(); timings[k] = (timings[k] || 0) + n - t; t = n; } };
  ensureBuffers(w, h);
  grayscale(rgba, w, h); lap('gray');
  adaptiveThreshold(p.kernel, p.thresh); lap('threshold');
  const minSize = w * 0.01;
  det.contours = findContours(minSize); lap('contours');
  let cands = det.findCandidates(det.contours, minSize, 0.05, 10);
  cands = det.clockwiseCorners(cands).filter(plausible);
  cands = det.notTooNear(cands, 6); lap('candidates');
  if (det.grey.data !== buf.gray) det.grey = new CV.Image(w, h, buf.gray);
  det.grey.width = w; det.grey.height = h;
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
  lap('decode');
  return out;
}

function detectAndVerify(det, rgba, w, h, maxErrors, expect, timings) {
  const found = detect(det, rgba, w, h, maxErrors, timings);
  if (expect?.length) {
    const t = performance.now();
    found.push(...verifyExpected(det, expect, found, w, h));
    if (timings) timings.verify = performance.now() - t;
  }
  return found;
}

// Frames arrive either as RGBA pixels from the page, or as an ImageBitmap of the whole
// camera frame plus the crop to scan. The bitmap path keeps scaling and the pixel
// readout off the page's thread, where they would compete with drawing the screen.
let grabCanvas = null, grabCtx = null;
function pixelsFromBitmap(bitmap, r, w, h) {
  if (!grabCanvas) {
    grabCanvas = new OffscreenCanvas(w, h);
    grabCtx = grabCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (grabCanvas.width !== w || grabCanvas.height !== h) { grabCanvas.width = w; grabCanvas.height = h; }
  grabCtx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, w, h);
  bitmap.close();
  return grabCtx.getImageData(0, 0, w, h).data;
}

onmessage = (e) => {
  const { width, height, buffer, bitmap, crop, dict, roi, correct, seq, profile, expect } = e.data;
  if (e.data.warm) {
    // Load the marker set and compute its error budget before the first frame needs it.
    try { getDetector(e.data.warm); } catch {}
    postMessage({ warm: true });
    return;
  }
  if (e.data.probe) {
    // Can this browser draw into a canvas inside a worker?
    let ok = false;
    try { ok = typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d'); } catch {}
    postMessage({ probe: true, offscreen: ok });
    return;
  }
  const t0 = performance.now();
  const timings = profile ? {} : null;
  let markers = [];
  let error = null;
  try {
    const rgba = bitmap ? pixelsFromBitmap(bitmap, crop, width, height) : new Uint8ClampedArray(buffer);
    if (timings) timings.readout = performance.now() - t0;
    const det = getDetector(dict);
    const maxErrors = correct ? det.correctable : 0;
    const found = detectAndVerify(det, rgba, width, height, maxErrors, expect, timings);
    // Stick with a threshold setting while it works; rotate through the others when it doesn't.
    if (found.length) det.misses = 0;
    else if (++det.misses >= 2) { det.pass = (det.pass + 1) % PASSES.length; det.misses = 0; }
    const ox = roi ? roi.x : 0, oy = roi ? roi.y : 0, s = roi ? roi.scale : 1;
    markers = found.map((m) => ({
      id: m.id,
      corners: m.corners.map((c) => [c.x / s + ox, c.y / s + oy]),
      err: m.err,
      verified: !!m.verified,
    }));
  } catch (err) {
    error = String(err);
  }
  const msg = { markers, ms: performance.now() - t0, error, seq, timings };
  // Hand a pixel buffer back so the page can reuse it.
  if (buffer) { msg.buffer = buffer; postMessage(msg, [buffer]); } else postMessage(msg);
};
