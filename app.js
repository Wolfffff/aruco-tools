const $ = (id) => document.getElementById(id);
// The page loads this script as app.js?v=N; the worker gets the same N, so a phone never
// mixes files from two releases (old cached page with new script, or the reverse).
const BUILD = new URL(document.currentScript.src).search;
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d', { alpha: false });
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

/* ---------- marker sets ---------- */

// OpenCV's DICT_NxN_50/100/250 are the first codes of DICT_NxN_1000; smaller sets
// leave more room between codes, so fewer random patterns can match one.
// `key` is stored in localStorage (and read by the sheet generator); `label` is what people see.
const FAMILIES = [
  { key: '4x4', label: '4×4', base: 'ARUCO_4X4_1000', name: 'DICT_4X4', sizes: [50, 100, 250, 1000] },
  { key: '5x5', label: '5×5', base: 'ARUCO_5X5_1000', name: 'DICT_5X5', sizes: [50, 100, 250, 1000] },
  { key: '6x6', label: '6×6', base: 'ARUCO_6X6_1000', name: 'DICT_6X6', sizes: [50, 100, 250, 1000] },
  { key: '7x7', label: '7×7', base: 'ARUCO_7X7_1000', name: 'DICT_7X7', sizes: [50, 100, 250, 1000] },
  { key: 'Original', label: 'ArUco original', base: 'ARUCO_DEFAULT_OPENCV', name: 'DICT_ARUCO_ORIGINAL' },
  { key: 'MIP 36h12', label: 'ArUco MIP', base: 'ARUCO_MIP_36h12', name: 'DICT_ARUCO_MIP_36h12' },
  { key: 'April 16h5', label: 'AprilTag 16h5', base: 'APRILTAG_16h5', name: 'DICT_APRILTAG_16h5' },
  { key: 'April 25h9', label: 'AprilTag 25h9', base: 'APRILTAG_25h9', name: 'DICT_APRILTAG_25h9' },
  { key: 'April 36h11', label: 'AprilTag 36h11', base: 'APRILTAG_36h11', name: 'DICT_APRILTAG_36h11' },
];
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
// Pixel budget per detection pass: the longest side of the frame handed to the detector.
// The 2x center pass gets the same budget, so with a 4K camera it reads native pixels.
// 0 = native: every camera pixel, no downscaling.
const SPEED_OPTIONS = [[640, '640'], [960, '960'], [1280, '1280'], [1920, '1920'], [0, 'Native']];
const CAMERA_OPTIONS = [['1080', '1080p'], ['4k', '4K']];
const CAMERA_SIZES = { '1080': [1920, 1080], '4k': [3840, 2160] };
const AREA_OPTIONS = [['auto', 'Auto'], ['full', 'Whole frame'], ['center', 'Far only (2×)']];

// A tag is shown only after it is read twice at the same place, which removes nearly
// all one-frame misreads of textures and text.
const CONFIRM_HITS = 2;
// A confirmed tag a pass misses (usually motion blur) stays, moving with the camera, and
// fades out over a few passes. In auto mode a tag may only be visible to every other pass
// (whole frame vs center), so it gets one more.
const holdPasses = () => (state.area === 'auto' ? 4 : 3);

// Fully visible while being read; fades out over the hold when missed, in over two passes
// when first confirmed.
function trackAlpha(t) {
  const missed = state.passNo - t.pass;
  const out = missed === 0 ? 1 : Math.max(0, 1 - missed / (holdPasses() + 1));
  const fadeIn = Math.min(1, (state.passNo - (t.confirmedAt ?? state.passNo) + 1) / 2);
  return out * fadeIn;
}

/* ---------- camera motion ----------
   The screen shows the live camera. Detection results describe a frame from a few tens of
   milliseconds ago, so outlines are moved by how much the picture itself has moved since
   that frame: sliding (pan, tilt), scaling (zoom, moving closer or away) and twisting.

   Each frame, a 160 px wide copy is split into a 3×3 grid. In each cell the sideways and
   up/down shift is found by matching column and row brightness profiles with the previous
   frame. A single slide + scale + rotation is then fitted to the nine shifts by least
   squares (zooming moves the outer cells outward, twisting moves them around), ignoring
   cells without enough texture or that disagree (a hand passing through). About a
   millisecond per frame.

   Transforms are similarities about the frame centre, in camera pixels:
   p' = [a −b; b a]·p + t. `motion.M` maps an arbitrary start frame to the current one. */

const MOTION_W = 160;
const GRID = 3;
const motionCanvas = document.createElement('canvas');
const mctx = motionCanvas.getContext('2d');
const IDENTITY = { a: 1, b: 0, tx: 0, ty: 0 };
const motion = { prev: null, M: { ...IDENTITY } };

const compose = (D, M) => ({ // D after M
  a: D.a * M.a - D.b * M.b, b: D.a * M.b + D.b * M.a,
  tx: D.a * M.tx - D.b * M.ty + D.tx, ty: D.b * M.tx + D.a * M.ty + D.ty,
});
const invert = (M) => {
  const d = M.a * M.a + M.b * M.b, a = M.a / d, b = -M.b / d;
  return { a, b, tx: -(a * M.tx - b * M.ty), ty: -(b * M.tx + a * M.ty) };
};

// Column sums per horizontal band and row sums per vertical band; each grid cell's
// profiles are slices of these. Uses the green channel.
function bandProfiles(data, w, h) {
  const cols = Array.from({ length: GRID }, () => new Float32Array(w));
  const rows = Array.from({ length: GRID }, () => new Float32Array(h));
  for (let y = 0, i = 1; y < h; y++) {
    const by = Math.min(GRID - 1, ((y * GRID) / h) | 0);
    const cb = cols[by];
    for (let x = 0; x < w; x++, i += 4) {
      const g = data[i];
      cb[x] += g;
      rows[Math.min(GRID - 1, ((x * GRID) / w) | 0)][y] += g;
    }
  }
  return { cols, rows };
}

// Derivative of a profile slice: edges, not brightness, so exposure changes don't count.
function edges(p, from, to) {
  const o = new Float32Array(to - from - 1);
  for (let i = 0; i < o.length; i++) o[i] = p[from + i + 1] - p[from + i];
  return o;
}

// Shift s (sub-sample) with cur[i + s] ≈ prev[i], or null when the slice has too little
// texture or the best match is not clearly better than the rest.
function matchShift(prev, cur, range) {
  const n = prev.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += Math.abs(prev[i]);
  if (energy / n < 2) return null; // flat: a wall, the sky
  let best = 0, bestCost = Infinity, sum = 0;
  const costs = new Float32Array(2 * range + 1);
  for (let s = -range; s <= range; s++) {
    let c = 0, k = 0;
    for (let i = Math.max(0, -s); i < Math.min(n, n - s); i++, k++) c += Math.abs(prev[i] - cur[i + s]);
    c /= Math.max(1, k);
    costs[s + range] = c; sum += c;
    if (c < bestCost) { bestCost = c; best = s; }
  }
  if (best === -range || best === range) return null; // at the edge of the search
  if (bestCost > 0.8 * (sum / costs.length)) return null; // no distinct match
  const l = costs[best + range - 1], m = costs[best + range], r = costs[best + range + 1];
  const den = l - 2 * m + r;
  return best + (den > 0 ? (0.5 * (l - r)) / den : 0);
}

// Least-squares similarity from point pairs (centre-relative), optionally dropping outliers.
function fitSimilarity(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sa = 0, sb = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - nx, v = dst[i][1] - ny;
    sa += x * u + y * v; sb += x * v - y * u; ss += x * x + y * y;
  }
  const a = ss > 0 ? sa / ss : 1, b = ss > 0 ? sb / ss : 0;
  return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) };
}

const apply = (M, p) => [M.a * p[0] - M.b * p[1] + M.tx, M.b * p[0] + M.a * p[1] + M.ty];

function frameDelta(prev, cur, w, h) {
  const src = [], dst = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.round((gx * w) / GRID), x1 = Math.round(((gx + 1) * w) / GRID);
      const y0 = Math.round((gy * h) / GRID), y1 = Math.round(((gy + 1) * h) / GRID);
      const dx = matchShift(edges(prev.cols[gy], x0, x1), edges(cur.cols[gy], x0, x1), 8);
      const dy = matchShift(edges(prev.rows[gx], y0, y1), edges(cur.rows[gx], y0, y1), 10);
      if (dx === null || dy === null) continue;
      const c = [(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - h / 2];
      src.push(c); dst.push([c[0] + dx, c[1] + dy]);
    }
  }
  if (src.length < 3) return null;
  let D = fitSimilarity(src, dst);
  // Drop cells that disagree with the rest (something moving on its own), then refit.
  const keep = src.map((p, i) => Math.hypot(...apply(D, p).map((v, k) => v - dst[i][k])) < 1.5);
  if (keep.filter(Boolean).length >= 3 && keep.includes(false)) {
    D = fitSimilarity(src.filter((_, i) => keep[i]), dst.filter((_, i) => keep[i]));
  }
  // Keep it physical: per frame, zoom by at most 15% and twist by at most ~8 degrees.
  const scale = Math.hypot(D.a, D.b);
  if (scale < 0.85 || scale > 1.15 || Math.abs(Math.atan2(D.b, D.a)) > 0.14) return null;
  // A still camera: ignore sensor noise.
  if (Math.abs(scale - 1) < 0.002 && Math.abs(D.b) < 0.002 && Math.hypot(D.tx, D.ty) < 0.15) return IDENTITY;
  return D;
}

function updateMotion(vw, vh) {
  const w = MOTION_W, h = Math.max(16, Math.round((MOTION_W * vh) / vw));
  if (motionCanvas.width !== w || motionCanvas.height !== h) {
    motionCanvas.width = w; motionCanvas.height = h;
    motion.prev = null;
  }
  mctx.drawImage(video, 0, 0, w, h);
  const cur = bandProfiles(mctx.getImageData(0, 0, w, h).data, w, h);
  if (motion.prev) {
    const D = frameDelta(motion.prev, cur, w, h);
    if (D) {
      const k = vw / w; // camera pixels per motion-image pixel
      motion.M = compose({ a: D.a, b: D.b, tx: D.tx * k, ty: D.ty * k }, motion.M);
    }
  }
  motion.prev = cur;
}

// A track's corners as they would appear in the frame described by `to` (default: now).
function shifted(t, to = motion.M) {
  const R = compose(to, invert(t.ref));
  const cx = video.videoWidth / 2, cy = video.videoHeight / 2;
  return t.corners.map((c) => { const p = apply(R, [c[0] - cx, c[1] - cy]); return [p[0] + cx, p[1] + cy]; });
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  family: FAMILIES.find((f) => f.key === store.get('family')) || FAMILIES[0],
  size: +(store.get('size') || 50),
  res: SPEED_OPTIONS.some(([v]) => String(v) === store.get('speed')) ? +store.get('speed') : 960,
  cam: store.get('cam') === '4k' ? '4k' : '1080',
  // 'auto' = the plain wide back lens when the phone names it (see pickSteadyLens), else a deviceId.
  lens: store.get('lens') || 'auto',
  lenses: [], // back cameras: { id, label }
  revealed: false,
  events: [], // recent camera/screen changes, shown in the speed readout
  area: AREA_OPTIONS.some(([v]) => v === store.get('area')) ? store.get('area') : 'auto',
  correct: store.get('correct') === '1',
  showStats: store.get('stats') === '1',
  flip: false, // in auto mode, alternates whole-frame and center passes
  paused: false,
  switching: false, // camera restarting: keep the last frame on screen
  pending: false,
  loopsStarted: false,
  track: null,
  zoom: null, // { hw, min, max, step, value }: hw = the camera's own zoom, else digital
  tracks: [], // { id, corners, pass, hits }
  passNo: 0, // detection results received
  seen: new Map(), // id -> frames read (confirmed only)
  entered: new Map(), // id -> when it last came into view; orders the list, newest first
  detTimes: [],
  lastMs: 0,
  passGap: 33, // smoothed ms between detection results
};
if (state.family.sizes && !state.family.sizes.includes(state.size)) state.size = state.family.sizes[0];

const setKey = (f = state.family, size = state.size) => (f.sizes ? `${f.base}:${size}` : f.base);
const setLabel = (f = state.family, size = state.size) => (f.sizes ? `${f.name}_${size}` : f.name);

// Same ID always gets the same colour, so you can follow a tag across frames.
const hue = (id) => (id * 137.508 + 200) % 360;
const color = (id, a = 1) => `hsl(${hue(id)} 100% 62% / ${a})`;

/* ---------- camera ---------- */

async function startCamera() {
  $('err').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    return showError('No camera access on this page. Open it over https in Safari or Chrome.');
  }
  const btn = $('start');
  btn.disabled = true;
  btn.textContent = 'Starting camera…';
  try {
    let stream = await openStream(lensId());
    // iPhones hand Safari a combined camera that hops between lenses as it focuses, which
    // shows as a sudden zoom. Switch to the plain wide lens (behind the start screen).
    const steady = state.lens === 'auto' ? await pickSteadyLens(stream) : null;
    if (steady) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await openStream(steady);
    }
    video.srcObject = stream;
    state.track = stream.getVideoTracks()[0];
    setupTrackControls();
    await video.play();
    // iOS can paint the first frames before the video knows its real size, which shows
    // as a small picture that then jumps to full screen. Reveal only a real frame.
    await firstFrame();
    // Settle on the final stream size while the start screen still covers everything,
    // so the picture never visibly switches resolution after it appears.
    if (await upgradeResolution(state.track)) await firstFrame();
    btn.disabled = false;
    btn.textContent = 'Open camera';
    if (!$('settings').hidden) renderSettings(); // shows the new stream size after a switch
    // Reveal on the first analyzed frame, so every picture on screen comes from the same
    // snapshot pipeline (a raw video frame can be cropped slightly differently on iOS).
    startLoops();
    await firstShown();
    state.revealed = true;
    logEvent(`shown · ${video.videoWidth}×${video.videoHeight} · ${state.track.label || 'camera'}`);
    $('gate').hidden = true;
    $('top').hidden = false;
    $('bottom').hidden = false;
    $('stat').hidden = !state.showStats;
    requestWakeLock();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Open camera';
    showError(e.name === 'NotAllowedError'
      ? 'Camera access was denied. Allow it for this site in your browser settings and reload.'
      : 'Could not open the camera: ' + (e.message || e.name));
  }
}

const lensId = () => (state.lens !== 'auto' ? state.lens : store.get('steadyLens'));

async function openStream(deviceId) {
  const video = {
    width: { ideal: CAMERA_SIZES[state.cam][0] },
    height: { ideal: CAMERA_SIZES[state.cam][1] },
    frameRate: { ideal: 30 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video });
  } catch (e) {
    if (!deviceId || e.name === 'NotAllowedError') throw e;
    // A remembered lens can disappear (another phone, OS update): fall back to any back camera.
    store.set('steadyLens', '');
    if (state.lens !== 'auto') { state.lens = 'auto'; store.set('lens', 'auto'); }
    return openStream(null);
  }
}

// Back cameras, by label. Labels only exist once camera permission is granted.
async function listBackLenses() {
  const all = (await navigator.mediaDevices.enumerateDevices?.()) || [];
  const back = /back|rear|environment|rück|arrière|trasera|posteriore|traseira|背|후면/i;
  state.lenses = all.filter((d) => d.kind === 'videoinput' && back.test(d.label)).map((d) => ({ id: d.deviceId, label: d.label }));
  return state.lenses;
}

// The single wide lens ("Back Camera"), as opposed to the combined dual/triple camera or
// the ultra-wide and telephoto lenses. Returns its id if switching to it is needed.
async function pickSteadyLens(stream) {
  try {
    const lenses = await listBackLenses();
    const multi = /dual|triple|ultra|wide|tele|macro|weit|grand|gran|tele|广角|長焦|望远/i;
    const plain = lenses.find((l) => !multi.test(l.label));
    if (!plain) return null;
    store.set('steadyLens', plain.id);
    const current = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
    return current === plain.id ? null : plain.id;
  } catch {
    return null;
  }
}

const t0Page = performance.now();
function logEvent(text) {
  state.events.push(`${((performance.now() - t0Page) / 1000).toFixed(2)}s ${text}`);
  if (state.events.length > 4) state.events.shift();
}

// iOS in particular may answer a 1080p or 4K request with a smaller stream, depending on
// how the request is shaped. If that happens, ask again in other ways and keep the best.
async function upgradeResolution(track) {
  const [W, H] = CAMERA_SIZES[state.cam];
  const longSide = () => { const st = track.getSettings?.() || {}; return Math.max(st.width || 0, st.height || 0); };
  const settle = () => new Promise((r) => setTimeout(r, 250));
  let best = longSide(), bestAsk = null;
  if (!best || best >= W * 0.9) return false;
  const asks = [
    { width: { ideal: H }, height: { ideal: W } }, // the same size, asked portrait-first
    { width: { ideal: W } },
    { height: { ideal: W } },
    { width: { min: Math.round(W * 0.66), ideal: W } },
  ];
  for (const ask of asks) {
    if (state.track !== track) return false; // the camera was switched meanwhile
    try { await track.applyConstraints({ ...ask, frameRate: { ideal: 30 } }); } catch { continue; }
    await settle();
    const got = longSide();
    if (got > best) { best = got; bestAsk = ask; }
    if (got >= W * 0.9) break;
  }
  // The last attempt may have been a worse one; settle on the best that worked.
  if (state.track === track && bestAsk && longSide() < best) {
    await track.applyConstraints({ ...bestAsk, frameRate: { ideal: 30 } }).catch(() => {});
  }
  state.tracks = []; // positions may now be in a different stream size
  return Boolean(bestAsk);
}

// Resolves once the camera is really running at its final shape: a frame has been decoded
// and the reported size has not changed for ~150 ms. iPhones can report a landscape size
// for a moment before rotation is applied; revealing then would show the picture jump.
// Gives up waiting after 1.5 s.
function firstFrame() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let size = '', since = t0;
    const check = () => {
      const now = performance.now();
      const ready = video.videoWidth > 0 && video.readyState >= 2;
      const cur = ready ? video.videoWidth + 'x' + video.videoHeight : '';
      if (cur !== size) { size = cur; since = now; }
      if ((ready && now - since >= 150) || now - t0 > 1500) resolve();
      else setTimeout(check, 16);
    };
    check();
  });
}

// Resolves when the first analyzed frame is ready to show (or after 1 s, as a fallback).
function firstShown() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      if (state.passNo > 0 || state.switching || performance.now() - t0 > 1000) resolve();
      else setTimeout(check, 8);
    };
    check();
  });
}

function setupTrackControls() {
  // No focus/exposure requests: continuous is already the default on phones, and on
  // iPhones an extra request can make the camera reconfigure (a visible jump).
  const caps = state.track.getCapabilities?.() || {};
  $('torch').hidden = !caps.torch;
  // Use the camera's own zoom where the browser exposes it; otherwise zoom digitally.
  const hw = caps.zoom && caps.zoom.max > caps.zoom.min;
  state.zoom = hw
    ? { hw, min: caps.zoom.min, max: Math.min(caps.zoom.max, 10), step: caps.zoom.step || 0.1, value: state.track.getSettings?.().zoom || caps.zoom.min }
    : { hw, min: 1, max: 4, step: 0.01, value: 1 };
}

/* ---------- zoom (pinch on the picture) ---------- */

// Digital zoom factor: 1 with camera zoom. The video is scaled on screen and detection
// crops to the visible area, so the pixel budget goes to what you are looking at.
const digitalZoom = () => (state.zoom && !state.zoom.hw ? state.zoom.value : 1);

let zoomQueued = false;
function setZoom(value) {
  const z = state.zoom;
  if (!z) return;
  z.value = Math.min(z.max, Math.max(z.min, Math.round(value / z.step) * z.step));
  showZoomHint();
  if (!z.hw) return; // digital zoom is applied when painting and scanning
  // Coalesce to one camera update per frame; pinches fire far more often than that.
  if (zoomQueued) return;
  zoomQueued = true;
  requestAnimationFrame(() => {
    zoomQueued = false;
    state.track?.applyConstraints({ advanced: [{ zoom: z.value }] }).catch(() => {});
  });
}

let hintTimer = 0;
function showZoomHint() {
  const z = state.zoom.value;
  $('zoomHint').textContent = (Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1)) + '×';
  $('zoomHint').classList.add('on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => $('zoomHint').classList.remove('on'), 900);
}

let pinch = null;
const touchGap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
$('stage').addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && state.zoom) pinch = { d: touchGap(e.touches), z: state.zoom.value };
}, { passive: true });
$('stage').addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  setZoom(pinch.z * touchGap(e.touches) / pinch.d);
}, { passive: false });
$('stage').addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });

// Keep the zoom label just above the bottom panel, whatever its height.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--panel-h', entry.target.getBoundingClientRect().height + 'px');
}).observe($('bottom'));

function showError(msg) {
  $('err').textContent = msg;
  $('err').hidden = false;
}

async function requestWakeLock() {
  try { await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.track) return;
  requestWakeLock();
  // iOS stops the camera when the app is backgrounded; bring it back.
  if (state.track.readyState === 'ended') restartCamera();
  else video.play().catch(() => {});
});

async function restartCamera() {
  // Hold the last analyzed frame on screen until the new stream has settled.
  state.switching = true;
  state.track?.stop();
  state.track = null;
  state.tracks = []; // positions are in the old stream's pixels
  try {
    await startCamera();
  } finally {
    state.switching = false;
  }
}

/* ---------- detection ---------- */

// Two detection workers, so a new frame can start while the previous one is still being
// read; results carry a sequence number and a late result never replaces a newer frame on
// screen. Safari under-reports cores on purpose (an iPhone has six), so only a browser that
// reports a single core gets one worker.
const workers = Array.from({ length: (navigator.hardwareConcurrency || 2) > 1 ? 2 : 1 }, () => {
  const w = new Worker('worker.js' + BUILD);
  w.busy = false;
  w.onmessage = (e) => onWorkerMessage(w, e.data);
  return w;
});

// Where supported, the page takes a GPU snapshot of the frame (createImageBitmap), paints
// the screen from it, and hands it to a worker, which scales it and reads the pixels.
// That keeps the slow CPU-side scaling and readout off the page's thread entirely.
let bitmapPath = false;
if (typeof createImageBitmap === 'function') {
  workers[0].busy = true;
  workers[0].postMessage({ probe: true });
}

let frameSeq = 0;
let shownSeq = 0;
const frameRef = new Map(); // seq -> picture shift when that frame was sent for reading

// The part of the video frame being scanned, in video pixels.
function scanRect(vw, vh, center) {
  const f = (center ? 0.5 : 1) / digitalZoom(); // what is on screen, or the middle half of it
  const w = Math.round(vw * f), h = Math.round(vh * f);
  return { x: (vw - w) >> 1, y: (vh - h) >> 1, w, h };
}

function sendFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || video.readyState < 2 || state.switching) return;
  const worker = workers.find((w) => !w.busy);
  if (!worker) return; // every worker busy: skip this frame, the next one is moments away
  state.flip = !state.flip;
  const center = state.area === 'center' || (state.area === 'auto' && state.flip);
  const r = scanRect(vw, vh, center);
  // Every pass gets the same pixel budget. Crops (the center pass, digital zoom) therefore
  // read native pixels, and may upsample up to 2x so tiny tags have cells big enough to read.
  const cropped = center || digitalZoom() > 1;
  const budget = state.res || Math.max(r.w, r.h); // native: one detector pixel per camera pixel
  const scale = Math.min(cropped && state.res ? 2 : 1, budget / Math.max(r.w, r.h));
  const w = Math.round(r.w * scale), h = Math.round(r.h * scale);
  state.scanW = w; state.scanH = h;
  const seq = ++frameSeq;
  frameRef.set(seq, { ...motion.M });
  // Confirmed tags and where they should be in this frame, in scan pixels, so the worker
  // can re-check those spots if its full scan misses them.
  const expect = [];
  for (const t of state.tracks) {
    if (t.hits < CONFIRM_HITS || state.passNo - t.pass > 2) continue;
    const c = shifted(t).map((p) => [(p[0] - r.x) * scale, (p[1] - r.y) * scale]);
    const [mx, my] = centroid(c);
    if (mx >= 0 && my >= 0 && mx < w && my < h) expect.push({ id: t.id, corners: c });
  }
  const msg = { width: w, height: h, dict: setKey(), roi: { x: r.x, y: r.y, scale }, correct: state.correct, seq, expect };
  worker.busy = true;
  if (bitmapPath) {
    createImageBitmap(video).then((bitmap) => {
      if (bitmap.width !== vw || bitmap.height !== vh) {
        // Some browsers snapshot the raw, unrotated sensor frame. Reading that would be
        // sideways, so use the plain path on this phone from now on.
        bitmap.close();
        bitmapPath = false;
        worker.busy = false;
        return;
      }
      worker.postMessage({ ...msg, bitmap, crop: r }, [bitmap]);
    }, () => {
      bitmapPath = false; // snapshot failed (rare): read pixels here from now on
      worker.busy = false;
    });
    return;
  }
  if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
  gctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const img = gctx.getImageData(0, 0, w, h);
  worker.postMessage({ ...msg, buffer: img.data.buffer }, [img.data.buffer]);
}

function onWorkerMessage(worker, data) {
  if (data.warm) return;
  worker.busy = false;
  if (data.probe) {
    bitmapPath = data.offscreen;
    return;
  }
  const { markers, ms, error, seq } = data;
  const ref = frameRef.get(seq);
  for (const k of frameRef.keys()) if (k <= seq) frameRef.delete(k);
  // A result older than one already applied (two workers can finish out of order) is dropped.
  if (seq <= shownSeq || !ref || state.paused || state.switching) return;
  shownSeq = seq;
  if (error) console.error(error);
  else onResult(markers, ms, ref);
}

function onResult(markers, ms, ref) {
  const now = performance.now();
  state.passNo++;
  for (const m of markers) addRead(m, ref);
  state.tracks = state.tracks.filter((t) => state.passNo - t.pass <= holdPasses() + 1);
  state.lastMs = ms;
  const dt = state.detTimes;
  if (dt.length) state.passGap = state.passGap * 0.8 + Math.min(1000, now - dt[dt.length - 1]) * 0.2;
  dt.push(now);
  while (dt.length && now - dt[0] > 1000) dt.shift();
}

// Confirmed tags that belong on screen now.
const visibleTracks = () => state.tracks.filter((t) => t.hits >= CONFIRM_HITS && state.passNo - t.pass <= holdPasses());

const centroid = (c) => [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
const sideLen = (c) => Math.hypot(c[0][0] - c[2][0], c[0][1] - c[2][1]) / 1.414;

// `ref` is the picture shift of the frame this read came from; tracks keep theirs, so any
// two can be compared after removing the camera's motion between them.
function addRead(m, ref) {
  const [cx, cy] = centroid(m.corners);
  const reach = Math.max(24, sideLen(m.corners));
  let best = null, bestD = Infinity;
  for (const t of state.tracks) {
    if (t.id !== m.id || t.pass === state.passNo) continue;
    const [tx, ty] = centroid(shifted(t, ref));
    const d = Math.hypot(tx - cx, ty - cy);
    if (d < reach && d < bestD) { best = t; bestD = d; }
  }
  if (best) {
    best.corners = m.corners;
    best.ref = ref;
    best.pass = state.passNo;
    best.hits++;
    if (best.hits === CONFIRM_HITS) best.confirmedAt = state.passNo;
    if (best.hits >= CONFIRM_HITS) markSeen(m.id);
  } else if (!m.verified) {
    state.tracks.push({ id: m.id, corners: m.corners, ref, pass: state.passNo, hits: 1 });
  }
}

let seenDirty = true;
function markSeen(id) {
  if (!state.seen.has(id)) { seenDirty = true; navigator.vibrate?.(12); }
  state.seen.set(id, (state.seen.get(id) || 0) + 1);
}

// Every new camera frame: measure how the picture moved, paint it with the outlines
// moved to match, and hand it to a free worker if there is one.
function onVideoFrame() {
  if (state.paused || state.switching) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || video.readyState < 2) return;
  updateMotion(vw, vh);
  draw();
  sendFrame();
}

function startLoops() {
  if (state.loopsStarted) return;
  state.loopsStarted = true;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const tick = () => { video.requestVideoFrameCallback(tick); onVideoFrame(); };
    video.requestVideoFrameCallback(tick);
  } else {
    let lastTime = -1;
    const tick = () => {
      requestAnimationFrame(tick);
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; onVideoFrame(); }
    };
    requestAnimationFrame(tick);
  }
  // Readouts on their own loop; it books its next run first so an error cannot stop it.
  const paint = () => {
    requestAnimationFrame(paint);
    renderReadouts();
  };
  requestAnimationFrame(paint);
}

/* ---------- drawing ---------- */

function screenSize() {
  const dpr = Math.min(devicePixelRatio || 1, 2); // 3x costs fill-rate on big phones for no visible gain
  return { dpr, cw: Math.round(overlay.clientWidth * dpr), ch: Math.round(overlay.clientHeight * dpr) };
}

// Fill the screen with the camera, cropping the overflow (like object-fit: cover),
// magnified about the center by any digital zoom.
function paintVideo(ctx, source, vw, vh, cw, ch) {
  const s = Math.max(cw / vw, ch / vh) * digitalZoom();
  ctx.drawImage(source, cw / 2 - (vw * s) / 2, ch / 2 - (vh * s) / 2, vw * s, vh * s);
  return s;
}

let lastVideoSize = '';

function draw() {
  const { dpr, cw, ch } = screenSize();
  const vw = video.videoWidth, vh = video.videoHeight;
  // If the stream changes shape mid-session (rotation, a camera reconfiguring), drop tags
  // from the old shape rather than drawing them in the wrong place.
  const size = vw + 'x' + vh;
  if (size !== lastVideoSize) {
    if (lastVideoSize) { state.tracks = []; if (state.revealed && vw) logEvent(`camera size ${size}`); }
    lastVideoSize = size;
  }
  if (overlay.width !== cw || overlay.height !== ch) {
    if (state.revealed) logEvent(`screen size ${cw}×${ch}`);
    overlay.width = cw; overlay.height = ch;
  }
  if (!vw) return;
  const s = paintVideo(octx, video, vw, vh, cw, ch);
  const P = (p) => [(p[0] - vw / 2) * s + cw / 2, (p[1] - vh / 2) * s + ch / 2];
  if (state.area === 'center') drawScanArea(scanRect(vw, vh, true), P, dpr);
  // All outlines first, then all labels, so a box can never cover another tag's number.
  const shown = visibleTracks().map((t) => ({ id: t.id, q: shifted(t).map(P), a: trackAlpha(t) }));
  for (const m of shown) drawBox(m.id, m.q, m.a, dpr);
  for (const m of shown) drawLabel(m.id, m.q, m.a, dpr);
}

function drawScanArea(r, P, dpr) {
  const [x0, y0] = P([r.x, r.y]);
  const [x1, y1] = P([r.x + r.w, r.y + r.h]);
  octx.fillStyle = 'rgba(0,0,0,0.45)';
  octx.beginPath();
  octx.rect(0, 0, overlay.width, overlay.height);
  octx.rect(x0, y0, x1 - x0, y1 - y0);
  octx.fill('evenodd');
  octx.strokeStyle = 'rgba(255,255,255,0.9)';
  octx.lineWidth = 3 * dpr;
  octx.lineCap = 'round';
  brackets([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], Math.min(x1 - x0, y1 - y0) * 0.12);
}

// Short strokes at each corner of a quad, pointing along its edges.
function brackets(q, len) {
  octx.beginPath();
  for (let i = 0; i < 4; i++) {
    const p = q[i], a = q[(i + 1) % 4], b = q[(i + 3) % 4];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1;
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    octx.moveTo(p[0] + (a[0] - p[0]) / da * len, p[1] + (a[1] - p[1]) / da * len);
    octx.lineTo(p[0], p[1]);
    octx.lineTo(p[0] + (b[0] - p[0]) / db * len, p[1] + (b[1] - p[1]) / db * len);
  }
  octx.stroke();
}

const quadSide = (q) => (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;

function drawBox(id, q, alpha, dpr) {
  octx.globalAlpha = alpha;
  octx.lineJoin = 'round';
  // One clean outline in the tag's colour, with a faint tint and a soft shadow for contrast.
  octx.beginPath();
  octx.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < 4; i++) octx.lineTo(q[i][0], q[i][1]);
  octx.closePath();
  octx.fillStyle = color(id, 0.14);
  octx.fill();
  octx.shadowColor = 'rgba(0,0,0,0.45)';
  octx.shadowBlur = 6 * dpr;
  octx.strokeStyle = color(id);
  octx.lineWidth = 2.5 * dpr;
  octx.stroke();
  octx.shadowBlur = 0;
  octx.globalAlpha = 1;
}

// ID label centred above the tag. Anchored to the tag's centre and top edge, which move
// smoothly as it turns (a corner-anchored label jumps whenever another corner becomes
// the highest). Size steps in 2 px increments so it does not jitter with the tag.
function drawLabel(id, q, alpha, dpr) {
  const step = 2 * dpr;
  const fs = Math.max(12 * dpr, Math.min(20 * dpr, Math.round((quadSide(q) * 0.2) / step) * step));
  octx.globalAlpha = alpha;
  octx.font = `700 ${fs}px -apple-system, system-ui, Roboto, sans-serif`;
  const label = String(id);
  const tw = octx.measureText(label).width;
  const lx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const top = Math.min(q[0][1], q[1][1], q[2][1], q[3][1]);
  const h = fs * 1.5, w = Math.max(h, tw + fs * 0.9);
  const ly = Math.max(h / 2 + 2 * dpr, top - h / 2 - 6 * dpr);
  octx.shadowColor = 'rgba(0,0,0,0.35)';
  octx.shadowBlur = 4 * dpr;
  octx.fillStyle = color(id);
  roundRect(lx - w / 2, ly - h / 2, w, h, h / 2);
  octx.fill();
  octx.shadowBlur = 0;
  octx.fillStyle = '#000';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(label, lx, ly + fs * 0.05);
  octx.globalAlpha = 1;
}

function roundRect(x, y, w, h, r) {
  octx.beginPath();
  octx.moveTo(x + r, y);
  octx.arcTo(x + w, y, x + w, y + h, r);
  octx.arcTo(x + w, y + h, x, y + h, r);
  octx.arcTo(x, y + h, x, y, r);
  octx.arcTo(x, y, x + w, y, r);
  octx.closePath();
}

/* ---------- readouts ---------- */

let statAt = 0;
let seenAt = 0;
let inViewKey = '';
const lastSeenAt = new Map(); // id -> when it was last in view

// Tiny drawings of tags for the list, from the same dictionary the detector uses.
const miniCache = new Map(); // `${setKey}:${id}` -> svg markup
let miniDict = null; // { base, dict } for the current family
async function ensureMiniDict() {
  const base = state.family.base;
  if (miniDict?.base === base) return;
  await loadDict(base);
  const def = AR.DICTIONARIES[base];
  const saved = def.tau;
  def.tau = 1; // skip the library's slow distance scan; drawing does not need it
  miniDict = { base, dict: new AR.Dictionary(base) };
  def.tau = saved;
  seenDirty = true;
}
function miniSvg(id) {
  if (!miniDict || miniDict.base !== state.family.base) return '';
  const k = miniDict.base + ':' + id;
  if (!miniCache.has(k)) miniCache.set(k, miniDict.dict.generateSVG(id));
  return miniCache.get(k);
}

function renderReadouts() {
  const now = performance.now();
  const inView = new Set(visibleTracks().map((t) => t.id));
  // A tag moves to the front only when it comes back after being gone for over a second;
  // brief dropouts (blur, a hand passing) don't reshuffle the list.
  for (const id of inView) {
    if (now - (lastSeenAt.get(id) ?? -Infinity) > 1000) state.entered.set(id, now);
    lastSeenAt.set(id, now);
  }
  // The in-view ring also ignores dropouts shorter than ~0.35 s.
  const ringed = new Set([...lastSeenAt].filter(([, t]) => now - t < 350).map(([id]) => id));
  const ringKey = [...ringed].sort((a, b) => a - b).join(',');
  if (seenDirty || ringKey !== inViewKey || (inView.size && now - seenAt > 400)) {
    inViewKey = ringKey;
    renderSeen(ringed);
  }
  if (state.showStats && now - statAt > 250) {
    statAt = now;
    $('stat').textContent = `build ${BUILD.replace('?v=', '')} · ${state.detTimes.length} reads/s · ${state.lastMs.toFixed(1)} ms · camera ${video.videoWidth}×${video.videoHeight} · scan ${state.scanW || 0}×${state.scanH || 0} · ${workers.length} worker${workers.length > 1 ? 's' : ''}${bitmapPath ? '' : ' (no bitmaps)'}` + (state.events.length ? '\n' + state.events.join('\n') : '');
  }
  $('live').classList.toggle('live', !state.paused && state.detTimes.length > 0 && now - state.detTimes[state.detTimes.length - 1] < 500);
}

// One card per tag read so far: tiny tag, its ID, and how many frames it was read in.
// Cards are kept by ID and only their text and state change between renders.
const cards = new Map();
function renderSeen(inView = new Set()) {
  seenDirty = false;
  seenAt = performance.now();
  ensureMiniDict();
  const list = $('seen');
  const ids = [...state.seen.keys()].sort((a, b) => (state.entered.get(b) || 0) - (state.entered.get(a) || 0));
  $('seenCount').textContent = ids.length ? `${ids.length} tag${ids.length === 1 ? '' : 's'} read` : 'No tags yet';
  $('emptyHint').hidden = ids.length > 0;
  for (const [id, el] of cards) if (!state.seen.has(id)) { el.remove(); cards.delete(id); }
  let prev = null;
  for (const id of ids) {
    let el = cards.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card';
      el.style.setProperty('--c', color(id));
      el.innerHTML = '<span class="mini"></span><span class="meta"><b></b><small></small></span>';
      el.querySelector('b').textContent = id;
      el.classList.add('new');
      el.addEventListener('animationend', () => el.classList.remove('new'), { once: true });
      cards.set(id, el);
    }
    const mini = el.querySelector('.mini');
    if (!mini.firstChild) mini.innerHTML = miniSvg(id);
    el.querySelector('small').textContent = '×' + state.seen.get(id);
    el.classList.toggle('live', inView.has(id));
    // Keep DOM order sorted without re-inserting cards that are already in place.
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
}

/* ---------- settings ---------- */

function options(el, list, current, onPick) {
  el.replaceChildren();
  for (const [value, label] of list) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', value === current);
    b.onclick = () => { onPick(value); renderSettings(); };
    el.append(b);
  }
}

function renderSettings() {
  options($('family'), FAMILIES.map((f) => [f, f.label]), state.family, (f) => {
    state.family = f;
    if (f.sizes && !f.sizes.includes(state.size)) state.size = f.sizes[0];
    store.set('family', f.key);
    resetReads();
  });
  $('sizeGroup').hidden = !state.family.sizes;
  options($('size'), (state.family.sizes || []).map((n) => [n, String(n)]), state.size, (n) => {
    state.size = n;
    store.set('size', String(n));
    resetReads();
  });
  $('dictName').textContent = `OpenCV: ${setLabel()}`;
  options($('speedOpts'), SPEED_OPTIONS, state.res, (v) => { state.res = v; store.set('speed', String(v)); });
  options($('camOpts'), CAMERA_OPTIONS, state.cam, (v) => {
    if (v === state.cam) return;
    state.cam = v;
    store.set('cam', v);
    if (state.track) restartCamera();
  });
  const short = (l) => l.replace(/^back\s*/i, '').replace(/\s*camera$/i, '') || 'Wide';
  options($('lensOpts'), [['auto', 'Auto (steady)'], ...state.lenses.map((l) => [l.id, short(l.label)])], state.lens, (v) => {
    if (v === state.lens) return;
    state.lens = v;
    store.set('lens', v);
    if (state.track) restartCamera();
  });
  $('lensGroup').hidden = !state.lenses.length;
  $('camNow').textContent = video.videoWidth ? `Streaming ${Math.max(video.videoWidth, video.videoHeight)}×${Math.min(video.videoWidth, video.videoHeight)}.` : '';
  options($('areaOpts'), AREA_OPTIONS, state.area, (v) => { state.area = v; store.set('area', v); });
  options($('correctOpts'), [[false, 'Off'], [true, 'On']], state.correct, (v) => {
    state.correct = v;
    store.set('correct', v ? '1' : '0');
  });
  options($('statOpts'), [[false, 'Off'], [true, 'On']], state.showStats, (v) => {
    state.showStats = v;
    store.set('stats', v ? '1' : '0');
    $('stat').hidden = !v || $('top').hidden;
  });
  $('build').textContent = `Build ${BUILD.replace('?v=', '')}`;
  $('setName').textContent = state.family.label + (state.family.sizes ? ` · ${state.size} IDs` : '');
}

// Have every worker load the current marker set now, not on the first camera frame.
function warmWorkers() {
  for (const w of workers) w.postMessage({ warm: setKey() });
}

function resetReads() {
  warmWorkers();
  state.tracks = [];
  state.entered.clear();
  lastSeenAt.clear();
  state.seen.clear();
  seenDirty = true;
}

function openSettings() {
  if (state.track && !state.lenses.length) listBackLenses().then(renderSettings, () => {});
  renderSettings();
  $('scrim').hidden = false;
  $('settings').hidden = false;
}
function closeSettings() {
  $('scrim').hidden = true;
  $('settings').hidden = true;
}

/* ---------- controls ---------- */

$('start').onclick = startCamera;
$('setBtn').onclick = openSettings;
$('settingsBtn').onclick = openSettings;
$('settingsDone').onclick = closeSettings;
$('scrim').onclick = closeSettings;
$('pause').onclick = (e) => {
  state.paused = !state.paused;
  e.currentTarget.setAttribute('aria-pressed', state.paused);
  e.currentTarget.setAttribute('aria-label', state.paused ? 'Resume' : 'Freeze');
  $('pauseIcon').setAttribute('d', state.paused ? 'M7 4l12 8-12 8z' : 'M8 5v14M16 5v14');
  if (state.paused) video.pause();
  else video.play().catch(() => {});
};
$('torch').onclick = async (e) => {
  const btn = e.currentTarget;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  try {
    await state.track.applyConstraints({ advanced: [{ torch: on }] });
    btn.setAttribute('aria-pressed', on);
  } catch {}
};
$('clear').onclick = () => {
  state.seen.clear();
  seenDirty = true;
};
$('copy').onclick = async (e) => {
  const btn = e.currentTarget;
  const ids = [...state.seen.keys()].sort((a, b) => a - b);
  const text = ids.length ? `${setLabel()}: ${ids.join(', ')}` : '';
  try {
    if (!text) throw 0;
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = text ? 'Failed' : 'Empty';
  }
  setTimeout(() => (btn.textContent = 'Copy'), 1400);
};

/* ---------- marker display (to test from a second screen) ---------- */

const genSet = $('genSet');
for (const f of FAMILIES) {
  for (const n of f.sizes || [null]) {
    const o = document.createElement('option');
    o.value = n ? `${f.key}|${n}` : f.key;
    o.textContent = setLabel(f, n);
    genSet.append(o);
  }
}

function loadDict(name) {
  if (AR.DICTIONARIES[name]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/dictionaries/' + DICT_FILES[name] + '.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

const genCache = {};
async function renderMarker() {
  const [fk, n] = genSet.value.split('|');
  const f = FAMILIES.find((x) => x.key === fk);
  await loadDict(f.base);
  const dict = genCache[f.base] || (genCache[f.base] = (() => {
    const def = AR.DICTIONARIES[f.base];
    const saved = def.tau;
    def.tau = 1; // skip the library's slow distance scan; drawing does not need it
    const d = new AR.Dictionary(f.base);
    def.tau = saved;
    return d;
  })());
  const max = (n ? +n : dict.codeList.length) - 1;
  const id = Math.max(0, Math.min(max, parseInt($('genId').value, 10) || 0));
  $('genId').value = id;
  $('genId').max = max;
  $('markerSvg').innerHTML = dict.generateSVG(id);
  $('markerCaption').textContent = `${setLabel(f, n ? +n : undefined)} · id ${id}`;
}

function openSheet() {
  closeSettings();
  genSet.value = state.family.sizes ? `${state.family.key}|${state.size}` : state.family.key;
  $('sheet').hidden = false;
  renderMarker();
}
$('showMarker').onclick = openSheet;
$('gateMarker').onclick = openSheet;
$('genClose').onclick = () => ($('sheet').hidden = true);
genSet.onchange = renderMarker;
$('genId').oninput = renderMarker;
$('genPrev').onclick = () => { $('genId').value = (+$('genId').value || 0) - 1; renderMarker(); };
$('genNext').onclick = () => { $('genId').value = (+$('genId').value || 0) + 1; renderMarker(); };

/* ---------- init ---------- */

renderSettings();
renderSeen();
warmWorkers();

// If this site already has camera permission, skip the start screen's tap.
(async () => {
  try {
    const p = await navigator.permissions?.query({ name: 'camera' });
    if (p?.state === 'granted') startCamera();
  } catch {} // some browsers cannot query camera permission; the button still works
})();

// Start-screen emblem: a real DICT_4X4 marker, id 0.
$('mark').innerHTML = Array.from({ length: 36 }, (_, i) => {
  const x = i % 6, y = (i / 6) | 0;
  const inner = x > 0 && x < 5 && y > 0 && y < 5;
  return `<i class="${inner && '1011010100110010'[(y - 1) * 4 + (x - 1)] === '1' ? 'w' : ''}"></i>`;
}).join('');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // An update was installed in the background: load it right away if the camera is not
  // showing yet, otherwise the next time the app goes to the background.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, not an update
    if (!state.revealed) location.reload();
    else document.addEventListener('visibilitychange', () => { if (document.hidden) location.reload(); });
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
