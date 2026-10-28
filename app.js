const $ = (id) => document.getElementById(id);
// The page loads this script as app.js?v=N; the worker gets the same N, so a phone never
// mixes files from two releases (old cached page with new script, or the reverse).
const BUILD = new URL(document.currentScript.src).search;
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d', { alpha: false });
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

/* ---------- settings values ---------- */

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
// A confirmed tag that a pass misses (motion blur, glare, a finger) is held: it moves with
// the camera, so it stays on the tag, and it is looked for again around that spot. The hold
// is a fixed time, not a number of passes, so it feels the same on fast and slow phones: it
// stays solid, then fades over its last stretch. A held tag that moves off screen is
// dropped at once.
const HOLD_MS = 400;
const FADE_MS = 200;
const FADE_IN_MS = 150;
// Tags missed for at most this many passes are still looked for: in focus scans and in the
// worker's re-check of expected spots.
const RECHECK_PASSES = 3;

// While the camera swings, motion blur stops detection but the motion tracking keeps held
// tags on target, so the hold clock waits until the camera settles (at most SWING_MAX_MS
// after the last read). Missed for one pass is always bridged, even on a slow phone.
const SWING_MAX_MS = 1500;
function holdAge(t, now) {
  const settled = Math.min(Math.max(t.at, motion.lastFast), t.at + SWING_MAX_MS);
  return now - settled;
}
const isHeld = (t, now) => state.passNo - t.pass <= 1 || holdAge(t, now) <= HOLD_MS;

// Opacity, by time so it changes smoothly every painted frame: in over FADE_IN_MS when a
// tag is confirmed, solid while it is read or briefly missed, then out to nothing over the
// last FADE_MS of the hold.
function trackAlpha(t, now) {
  const age = holdAge(t, now);
  const out = state.passNo === t.pass ? 1 : Math.min(1, Math.max(0, (HOLD_MS - age) / FADE_MS));
  const fadeIn = Math.min(1, (now - (t.confirmedTime ?? now)) / FADE_IN_MS);
  return out * fadeIn;
}

// The opacity actually drawn glides toward trackAlpha at a capped rate, so a tag read again
// halfway through fading out comes back smoothly instead of jumping to full.
function displayAlpha(t, now) {
  const target = trackAlpha(t, now);
  const dt = t.drawnAt ? now - t.drawnAt : 0;
  t.drawnAt = now;
  if (t.shown == null) t.shown = target;
  else if (target > t.shown) t.shown = Math.min(target, t.shown + dt / FADE_IN_MS);
  else t.shown = Math.max(target, t.shown - dt / FADE_MS);
  return t.shown;
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
const motion = { prev: null, M: { ...IDENTITY }, lastFast: 0 }; // lastFast: when the camera last moved fast

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

// Shift s in [lo, hi] (sub-sample) with cur[base + i + s] ≈ prev[i], or null when the slice
// has too little texture, the best match sits at the edge of the window, or it is not
// clearly better than the rest. `cur` may be longer than `prev` (a whole band), so a slice
// keeps its full overlap even when the picture moved a lot.
function matchShift(prev, cur, lo, hi, base = 0) {
  const n = prev.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += Math.abs(prev[i]);
  if (energy / n < 2) return null; // flat: a wall, the sky
  let best = 0, bestCost = Infinity, sum = 0, count = 0;
  const costs = new Float32Array(hi - lo + 1);
  for (let s = lo; s <= hi; s++) {
    let c = 0, k = 0;
    const from = Math.max(0, -(base + s)), to = Math.min(n, cur.length - (base + s));
    for (let i = from; i < to; i++, k++) c += Math.abs(prev[i] - cur[base + i + s]);
    if (k < n / 3) { costs[s - lo] = Infinity; continue; } // too little overlap to judge
    c /= k;
    costs[s - lo] = c; sum += c; count++;
    if (c < bestCost) { bestCost = c; best = s; }
  }
  if (bestCost === Infinity || best === lo || best === hi) return null;
  if (bestCost > 0.8 * (sum / count)) return null; // no distinct match
  const l = costs[best - lo - 1], m = costs[best - lo], r = costs[best - lo + 1];
  const den = l - 2 * m + r;
  return best + (Number.isFinite(den) && den > 0 ? (0.5 * (l - r)) / den : 0);
}

// Pairs of samples summed: a half-resolution profile for the coarse search.
function halve(p) {
  const o = new Float32Array(p.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = p[2 * i] + p[2 * i + 1];
  return o;
}
function sumBands(bands) {
  const out = new Float32Array(bands[0].length);
  for (const b of bands) for (let i = 0; i < b.length; i++) out[i] += b[i];
  return out;
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

// Coarse to fine. First the whole picture's slide, from half-resolution profiles over a
// wide window, so a fast pan or a late frame (the picture moved a lot since the last one)
// is still caught. Then each grid cell refines around it, which reveals zoom and twist.
const COARSE_RANGE = 24; // half-resolution samples: ±48 motion px, about ±320 camera px
const FINE_WINDOW = 8;   // motion px around the coarse slide, per cell
function frameDelta(prev, cur, w, h) {
  const pc = halve(sumBands(prev.cols)), cc = halve(sumBands(cur.cols));
  const pr = halve(sumBands(prev.rows)), cr = halve(sumBands(cur.rows));
  const gx0 = matchShift(edges(pc, 0, pc.length), edges(cc, 0, cc.length), -COARSE_RANGE, COARSE_RANGE);
  const gy0 = matchShift(edges(pr, 0, pr.length), edges(cr, 0, cr.length), -COARSE_RANGE, COARSE_RANGE);
  const cx = gx0 === null ? 0 : Math.round(gx0 * 2), cy = gy0 === null ? 0 : Math.round(gy0 * 2);
  const src = [], dst = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.round((gx * w) / GRID), x1 = Math.round(((gx + 1) * w) / GRID);
      const y0 = Math.round((gy * h) / GRID), y1 = Math.round(((gy + 1) * h) / GRID);
      const dx = matchShift(edges(prev.cols[gy], x0, x1), edges(cur.cols[gy], 0, w), cx - FINE_WINDOW, cx + FINE_WINDOW, x0);
      const dy = matchShift(edges(prev.rows[gx], y0, y1), edges(cur.rows[gx], 0, h), cy - FINE_WINDOW, cy + FINE_WINDOW, y0);
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

function updateMotion(src, vw, vh) {
  const w = MOTION_W, h = Math.max(16, Math.round((MOTION_W * vh) / vw));
  if (motionCanvas.width !== w || motionCanvas.height !== h) {
    motionCanvas.width = w; motionCanvas.height = h;
    motion.prev = null;
  }
  mctx.drawImage(src, 0, 0, w, h);
  const cur = bandProfiles(mctx.getImageData(0, 0, w, h).data, w, h);
  if (motion.prev) {
    const D = frameDelta(motion.prev, cur, w, h);
    if (D) {
      const k = vw / w; // camera pixels per motion-image pixel
      motion.M = compose({ a: D.a, b: D.b, tx: D.tx * k, ty: D.ty * k }, motion.M);
      // Fast: more than ~1.5% of the frame per frame, by sliding, zooming or turning.
      const speed = Math.hypot(D.tx * k, D.ty * k) + (Math.abs(Math.hypot(D.a, D.b) - 1) + Math.abs(D.b)) * vw;
      if (speed > vw * 0.015) motion.lastFast = performance.now();
    }
  }
  motion.prev = cur;
}

// A track's corners as they would appear in the frame described by `to` (default: now).
function shifted(t, to = motion.M, corners = t.corners) {
  const R = compose(to, invert(t.ref));
  const cx = video.videoWidth / 2, cy = video.videoHeight / 2;
  return corners.map((c) => { const p = apply(R, [c[0] - cx, c[1] - cy]); return [p[0] + cx, p[1] + cy]; });
}

// Each new read corrects where the motion tracking had put a tag by a pixel or few (more
// while the camera swings and the picture blurs). Drawn as a jump, that is jitter, so the
// outline glides the correction in: the offset to the old outline decays over GLIDE_MS.
// Short enough that a tag moved by hand is followed without visible lag.
const GLIDE_MS = 70;
function drawnCorners(t, now) {
  if (!t.err) return t.corners;
  const k = Math.exp(-(now - t.errAt) / GLIDE_MS);
  if (k < 0.02) { t.err = null; return t.corners; }
  return t.corners.map((c, i) => [c[0] + t.err[i][0] * k, c[1] + t.err[i][1] * k]);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  family: MARKER_FAMILIES.find((f) => f.key === store.get('family')) || MARKER_FAMILIES[0],
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
  showStats: false, // diagnostic: off at every launch
  paused: false,
  switching: false, // camera restarting: keep the last frame on screen
  loopsStarted: false,
  track: null,
  zoom: null, // { hw, min, max, step, value }: hw = the camera's own zoom, else digital
  tracks: [], // { id, corners, pass, hits }
  passNo: 0, // detection results received
  seen: new Map(), // id -> frames read (confirmed only)
  entered: new Map(), // id -> when it last came into view; orders the list, newest first
  detTimes: [],
  lastMs: 0,
};
if (state.family.sizes && !state.family.sizes.includes(state.size)) state.size = state.family.sizes[0];

const setKey = (f = state.family, size = state.size) => setKeyOf(f, size);
const setLabel = (f = state.family, size = state.size) => setNameOf(f, size);

// Same ID always gets the same colour, so you can follow a tag across frames.
const hue = (id) => (id * 137.508 + 200) % 360;
const color = (id, a = 1) => `hsl(${hue(id)} 100% 62% / ${a})`;

/* ---------- camera ---------- */

// Each start gets a generation number. A newer start (another switch, the app coming back
// to the foreground) makes an older one stop at its next step and release its stream.
let cameraGen = 0;
const SUPERSEDED = Symbol('superseded');

async function startCamera() {
  const gen = ++cameraGen;
  const check = () => { if (gen !== cameraGen) throw SUPERSEDED; };
  $('err').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    return showError('This browser cannot use the camera here. Open the page over https in Safari or Chrome.');
  }
  const btn = $('start');
  btn.disabled = true;
  btn.textContent = 'Starting camera…';
  $('gate').classList.add('starting');
  // On a switch (lens, 4K, coming back from the background) the current stream keeps
  // running until the new one is ready.
  const previous = video.srcObject;
  let stream = null;
  try {
    stream = await openStream(lensId(), previous);
    check();
    // iPhones hand Safari a combined camera that hops between lenses as it focuses, which
    // shows as a sudden zoom. Switch to the plain wide lens (behind the start screen),
    // asking while the first stream still runs; if that fails, keep the first one.
    const steady = state.lens === 'auto' ? await pickSteadyLens(stream) : null;
    check();
    if (steady) {
      const next = await openStream(steady, stream).catch(() => null);
      check();
      if (next && next !== stream) { stopStream(stream); stream = next; }
    }
    const track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    if (previous && previous !== stream) stopStream(previous);
    state.track = track;
    setupTrackControls();
    await video.play();
    // Wait for a real frame of the final size, behind the start screen, so the picture
    // never appears small or switches resolution after it shows.
    await firstFrame();
    check();
    if (await upgradeResolution(track)) await firstFrame();
    check();
    if (!$('settings').hidden) renderSettings(); // shows the new stream size after a switch
    // Reveal on the first analyzed frame.
    startLoops();
    await firstShown();
    check();
    state.revealed = true;
    logEvent(`shown · ${video.videoWidth}×${video.videoHeight} · ${track.label || 'camera'}`);
    $('gate').hidden = true;
    $('top').hidden = false;
    $('bottom').hidden = false;
    $('stat').hidden = !state.showStats;
    // Reset the start screen only now it is hidden, so "Open camera" never flashes.
    btn.disabled = false;
    btn.textContent = 'Open camera';
    $('gate').classList.remove('starting');
    requestWakeLock();
    showTapHint();
  } catch (e) {
    // Release the camera whatever went wrong; an unreleased stream keeps the camera light
    // on and can make the next attempt fail.
    if (stream && stream !== video.srcObject) stopStream(stream);
    if (e === SUPERSEDED) return;
    stopStream(stream);
    stopStream(previous);
    video.srcObject = null;
    state.track = null;
    btn.disabled = false;
    btn.textContent = 'Open camera';
    $('gate').classList.remove('starting');
    // If the camera was already showing (a lens or 4K switch), bring the start screen back
    // so the message and the button are visible.
    state.revealed = false;
    $('gate').hidden = false;
    $('top').hidden = true;
    $('bottom').hidden = true;
    showError(e.name === 'NotAllowedError'
      ? 'Camera access is off for this site. Allow it in the browser settings, then tap Open camera.'
      : `The camera did not start (${e.message || e.name}). Tap Open camera to try again.`);
  }
}

const lensId = () => (state.lens !== 'auto' ? state.lens : store.get('steadyLens'));

const stopStream = (stream) => stream?.getTracks().forEach((t) => t.stop());

// Opens the camera. `previous` is a stream still running (the one being replaced): it is
// kept alive while asking, because once every camera stream has stopped, Safari may treat
// the next request as new and ask for permission again. Phones that cannot run two camera
// streams at once refuse; then the previous one is released and the request retried.
async function openStream(deviceId, previous = null) {
  const video = {
    width: { ideal: CAMERA_SIZES[state.cam][0] },
    height: { ideal: CAMERA_SIZES[state.cam][1] },
    frameRate: { ideal: 60 }, // smoother picture and outlines; detection takes what it can
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video });
  } catch (e) {
    if (e.name === 'NotAllowedError') throw e;
    if (previous && previous.active && (e.name === 'NotReadableError' || e.name === 'AbortError')) {
      stopStream(previous);
      return openStream(deviceId, null);
    }
    if (!deviceId) throw e;
    // A remembered lens can disappear (another phone, OS update): fall back to any back camera.
    store.set('steadyLens', '');
    if (state.lens !== 'auto') { state.lens = 'auto'; store.set('lens', 'auto'); }
    return openStream(null, previous);
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
    try { await track.applyConstraints({ ...ask, frameRate: { ideal: 60 } }); } catch { continue; }
    await settle();
    const got = longSide();
    if (got > best) { best = got; bestAsk = ask; }
    if (got >= W * 0.9) break;
  }
  // The last attempt may have been a worse one; settle on the best that worked.
  if (state.track === track && bestAsk && longSide() < best) {
    await track.applyConstraints({ ...bestAsk, frameRate: { ideal: 60 } }).catch(() => {});
  }
  state.tracks = []; // positions may now be in a different stream size
  dropInFlight();
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
  $('torch').setAttribute('aria-pressed', 'false'); // a new stream starts with the light off
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
const endPinch = (e) => { if (e.touches.length < 2) pinch = null; };
$('stage').addEventListener('touchend', endPinch);
$('stage').addEventListener('touchcancel', endPinch);

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
  // Hold the last frame on screen until the new stream has settled.
  state.switching = true;
  dropInFlight();
  state.tracks = []; // positions are in the old stream's pixels
  // The current stream keeps running until startCamera has the new one (see openStream).
  const gen = cameraGen + 1; // the generation startCamera is about to take
  try {
    await startCamera();
  } finally {
    if (gen === cameraGen) state.switching = false; // a newer restart owns the flag now
  }
}

/* ---------- detection ---------- */

// Several detection workers, so new frames start while earlier ones are still being read;
// results carry a sequence number and a late result never replaces a newer one. Three by
// default (Safari under-reports cores on purpose; an iPhone has six), four where eight or
// more are reported, one where only one is.
const cores = navigator.hardwareConcurrency || 4;
function makeWorker() {
  const w = new Worker('worker.js' + BUILD);
  w.busy = false;
  w.onmessage = (e) => onWorkerMessage(w, e.data);
  // A worker that fails to load or crashes (out of memory at 4K) is replaced, so its
  // `busy` flag can never stay stuck and take a share of the frames with it.
  w.onerror = (e) => { e.preventDefault?.(); replaceWorker(w); };
  return w;
}
function replaceWorker(w) {
  const i = workers.indexOf(w);
  if (i < 0) return;
  w.terminate();
  workers[i] = makeWorker();
  workers[i].postMessage({ warm: setKey() });
}
const STUCK_MS = 3000; // a frame takes tens of milliseconds; this long means the worker is gone
const workers = Array.from({ length: cores <= 1 ? 1 : cores >= 8 ? 4 : 3 }, makeWorker);

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
// The part of the video frame that is on screen (the picture fills the screen and its
// overflow is cropped, then any digital zoom), or the middle half of it for the center
// pass. Scanning only this spends no time on pixels nobody can see.
function scanRect(vw, vh, center) {
  const { cw, ch } = screenSize();
  const f = center ? 0.5 : 1;
  if (!cw || !ch) { // no screen size yet: the whole frame
    const w = Math.round(vw * f), h = Math.round(vh * f);
    return { x: (vw - w) >> 1, y: (vh - h) >> 1, w, h };
  }
  const cover = Math.max(cw / vw, ch / vh) * digitalZoom();
  const w = Math.min(vw, Math.round((cw / cover) * f)), h = Math.min(vh, Math.round((ch / cover) * f));
  return { x: (vw - w) >> 1, y: (vh - h) >> 1, w, h };
}

// Focus scan: the box around the tags being tracked (where they are now, from the camera
// motion), padded for movement. It is small, so it is fast and can be read at full camera
// resolution, which keeps tracked tags reading through blur. Null when there is nothing to
// focus on, or the box would cover most of the frame anyway.
function focusRect(vw, vh) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, side = 0;
  for (const t of state.tracks) {
    if (t.hits < CONFIRM_HITS || state.passNo - t.pass > RECHECK_PASSES) continue;
    const q = shifted(t);
    side = Math.max(side, sideLen(q));
    for (const p of q) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  }
  if (!side) return null;
  // Padded for movement, and kept within what is on screen.
  const pad = Math.max(32, side * 0.6), v = scanRect(vw, vh, false);
  x0 = Math.max(v.x, Math.floor(x0 - pad)); y0 = Math.max(v.y, Math.floor(y0 - pad));
  x1 = Math.min(v.x + v.w, Math.ceil(x1 + pad)); y1 = Math.min(v.y + v.h, Math.ceil(y1 + pad));
  const w = x1 - x0, h = y1 - y0;
  if (w < 16 || h < 16 || w * h > 0.5 * vw * vh) return null;
  return { x: x0, y: y0, w, h };
}

// What each frame reads. With tags in view, every other frame is a focus scan; the rest
// cover the whole frame (alternating with the 2× center in auto mode) to find new tags.
// Without tracked tags, auto mode alternates whole frame and centre. While tags are tracked,
// every other frame is a focus scan, and of the rest only every third is a centre pass, so
// whole-frame scans (which find new and returning tags anywhere on screen) still come often.
let passIndex = 0, wideIndex = 0;
function chooseRegion(vw, vh) {
  passIndex++;
  const focus = passIndex % 2 === 0 ? focusRect(vw, vh) : null;
  if (focus) return { r: focus, cropped: true };
  wideIndex++;
  const tracking = state.tracks.some((t) => t.hits >= CONFIRM_HITS);
  const center = state.area === 'center' || (state.area === 'auto' && wideIndex % (tracking ? 3 : 2) === 0);
  return { r: scanRect(vw, vh, center), cropped: center || digitalZoom() > 1 };
}

// Latency guard: if reading a frame takes too long on this phone, scan smaller until it
// keeps up, then grow back. Frequent reads matter more for feel than big ones.
const latency = { avg: 0, factor: 1 };
function noteLatency(ms) {
  latency.avg = latency.avg ? latency.avg * 0.85 + ms * 0.15 : ms;
  if (latency.avg > 45) latency.factor = Math.max(0.6, latency.factor * 0.95);
  else if (latency.avg < 25) latency.factor = Math.min(1, latency.factor * 1.03);
}

// `src` is this frame: an ImageBitmap (handed to the worker, or closed) or the video itself.
function sendFrame(src, vw, vh) {
  const isBitmap = src !== video;
  const now = performance.now();
  for (const w of workers) if (w.busy && now - w.busySince > STUCK_MS) replaceWorker(w);
  const worker = workers.find((w) => !w.busy);
  if (!worker) { if (isBitmap) src.close(); return; } // all busy: skip; the next frame is moments away
  const { r, cropped } = chooseRegion(vw, vh);
  // Every pass gets the same pixel budget, so crops read native pixels and may upsample up
  // to 2x for tiny tags. Native: one detector pixel per camera pixel.
  const budget = (state.res || Math.max(r.w, r.h)) * latency.factor;
  const scale = Math.min(cropped && state.res ? 2 : 1, budget / Math.max(r.w, r.h));
  const w = Math.round(r.w * scale), h = Math.round(r.h * scale);
  state.scanW = w; state.scanH = h;
  const seq = ++frameSeq;
  frameRef.set(seq, { ...motion.M });
  // Confirmed tags and where they should be in this frame, in scan pixels, so the worker
  // can re-check those spots if its full scan misses them.
  const expect = [];
  for (const t of state.tracks) {
    if (t.hits < CONFIRM_HITS || state.passNo - t.pass > RECHECK_PASSES) continue;
    const c = shifted(t).map((p) => [(p[0] - r.x) * scale, (p[1] - r.y) * scale]);
    const [mx, my] = centroid(c);
    if (mx >= 0 && my >= 0 && mx < w && my < h) expect.push({ id: t.id, corners: c });
  }
  const msg = { width: w, height: h, dict: setKey(), roi: { x: r.x, y: r.y, scale }, correct: state.correct, seq, expect };
  worker.busy = true;
  worker.busySince = now;
  if (isBitmap) {
    worker.postMessage({ ...msg, bitmap: src, crop: r }, [src]);
    return;
  }
  if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
  gctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const img = gctx.getImageData(0, 0, w, h);
  worker.postMessage({ ...msg, buffer: img.data.buffer }, [img.data.buffer]);
}

function onWorkerMessage(worker, data) {
  if (data.warm) return;
  worker.busy = false;
  if (data.loadError) { notify("This marker set isn't on the phone yet. Connect once to download it."); return; }
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

// Results still being computed belong to the old state after a reset; ignore them.
function dropInFlight() {
  shownSeq = frameSeq;
  frameRef.clear();
}

// A short message over the camera.
let noticeTimer = 0;
function notify(text) {
  $('notice').textContent = text;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($('notice').hidden = true), 3500);
}

function onResult(markers, ms, ref) {
  const now = performance.now();
  state.passNo++;
  for (const m of markers) addRead(m, ref);
  // Confirmed tags live through the hold. An unconfirmed read waits long enough to meet the
  // next whole-frame scan (passes rotate between focus, whole frame and centre), but not so
  // long that two chance misreads far apart in time could add up to a confirmation.
  state.tracks = state.tracks.filter((t) => (t.hits >= CONFIRM_HITS
    ? isHeld(t, now) || state.passNo - t.pass <= RECHECK_PASSES
    : state.passNo - t.pass <= 4 || now - t.at <= 300));
  state.lastMs = ms;
  noteLatency(ms);
  const dt = state.detTimes;
  dt.push(now);
  while (dt.length && now - dt[0] > 1000) dt.shift();
}

// Confirmed tags that belong on screen now.
function visibleTracks() {
  const now = performance.now();
  return state.tracks.filter((t) => t.hits >= CONFIRM_HITS
    && (t.pass === state.passNo || (isHeld(t, now) && onScreen(t))));
}

// Whether a held tag's centre (where the camera motion puts it now) is still on screen.
function onScreen(t) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return true;
  const r = scanRect(vw, vh, false);
  const [x, y] = centroid(shifted(t));
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

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
    const now = performance.now();
    // Where the outline is drawn now, in this read's frame, minus where the read puts it.
    const was = shifted(best, ref, drawnCorners(best, now));
    const err = was.map((p, i) => [p[0] - m.corners[i][0], p[1] - m.corners[i][1]]);
    // A big difference is a real move (or a bad prediction): show it at once.
    const glide = Math.max(...err.map((e) => Math.hypot(e[0], e[1]))) < reach * 0.5;
    best.err = glide ? err : null;
    best.errAt = now;
    best.corners = m.corners;
    best.ref = ref;
    best.pass = state.passNo;
    best.at = now;
    best.hits++;
    if (best.hits === CONFIRM_HITS) best.confirmedTime = now;
    if (best.hits >= CONFIRM_HITS) markSeen(m.id);
  } else if (!m.verified) {
    state.tracks.push({ id: m.id, corners: m.corners, ref, pass: state.passNo, at: performance.now(), hits: 1 });
  }
}

let seenDirty = true;
function markSeen(id) {
  if (!state.seen.has(id)) {
    seenDirty = true;
    // Browsers refuse to vibrate before the first touch (the app opens straight to the camera).
    if (navigator.userActivation?.hasBeenActive ?? true) navigator.vibrate?.(12);
  }
  state.seen.set(id, (state.seen.get(id) || 0) + 1);
}

// Every new camera frame: take one snapshot and use it for everything, so motion, the
// picture on screen and detection can never disagree about which frame they saw. Then
// measure how the picture moved, paint it with the outlines moved to match, and hand it
// to a free worker if there is one.
let snapshotting = 0; // when the pending snapshot was requested, or 0
let snapshotFailures = 0;
function onVideoFrame() {
  if (state.paused || state.switching) return;
  // A snapshot normally takes well under a millisecond; one that never returns must not
  // stop painting and detection for good.
  if (snapshotting && performance.now() - snapshotting < 500) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || video.readyState < 2) return;
  if (!bitmapPath) { processFrame(video, vw, vh); return; }
  const asked = (snapshotting = performance.now());
  createImageBitmap(video).then((bitmap) => {
    if (snapshotting === asked) snapshotting = 0;
    snapshotFailures = 0;
    if (bitmap.width !== vw || bitmap.height !== vh) {
      // Some browsers snapshot the raw, unrotated sensor frame; that would be sideways.
      // Use the video directly on this phone from now on.
      bitmap.close();
      bitmapPath = false;
      return;
    }
    if (state.paused || state.switching) { bitmap.close(); return; }
    processFrame(bitmap, vw, vh);
  }, () => {
    if (snapshotting === asked) snapshotting = 0;
    if (++snapshotFailures >= 3) bitmapPath = false; // snapshots unavailable: use the video
  });
}

function processFrame(src, vw, vh) {
  updateMotion(src, vw, vh);
  draw(src);
  sendFrame(src, vw, vh); // last: it may hand the bitmap to a worker
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

function draw(src) {
  const { dpr, cw, ch } = screenSize();
  const vw = video.videoWidth, vh = video.videoHeight;
  // If the stream changes shape mid-session (rotation, a camera reconfiguring), drop tags
  // from the old shape rather than drawing them in the wrong place.
  const size = vw + 'x' + vh;
  if (size !== lastVideoSize) {
    if (lastVideoSize) { state.tracks = []; dropInFlight(); if (state.revealed && vw) logEvent(`camera size ${size}`); }
    lastVideoSize = size;
  }
  if (overlay.width !== cw || overlay.height !== ch) {
    if (state.revealed) logEvent(`screen size ${cw}×${ch}`);
    overlay.width = cw; overlay.height = ch;
  }
  if (!vw) return;
  const s = paintVideo(octx, src, vw, vh, cw, ch);
  const P = (p) => [(p[0] - vw / 2) * s + cw / 2, (p[1] - vh / 2) * s + ch / 2];
  if (state.area === 'center') drawScanArea(scanRect(vw, vh, true), P, dpr);
  // All outlines first, then all labels, so a box can never cover another tag's number.
  const now = performance.now();
  const shown = visibleTracks().map((t) => ({ id: t.id, q: shifted(t, motion.M, drawnCorners(t, now)).map(P), a: displayAlpha(t, now) })).filter((m) => m.a > 0.01);
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
  const fs = Math.max(12 * dpr, Math.min(20 * dpr, Math.round((sideLen(q) * 0.2) / step) * step));
  octx.globalAlpha = alpha;
  octx.font = `600 ${fs}px Geist, -apple-system, system-ui, sans-serif`;
  const label = String(id);
  const tw = octx.measureText(label).width;
  const lx = centroid(q)[0];
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

// Tiny drawings of markers for the list, from the same dictionary the detector uses.
// Empty until the dictionary has loaded; the list redraws then.
const miniCache = new Map(); // `${base}:${id}` -> svg markup
function miniSvg(id) {
  const base = state.family.base;
  if (!AR.DICTIONARIES[base]) {
    loadDictionary(base).then(() => { seenDirty = true; }, () => {});
    return '';
  }
  const k = base + ':' + id;
  if (!miniCache.has(k)) miniCache.set(k, drawingDictionary(base).generateSVG(id));
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
    $('stat').textContent = `build ${BUILD.replace('?v=', '')} · ${state.detTimes.length} reads/s · ${state.lastMs.toFixed(1)} ms · camera ${video.videoWidth}×${video.videoHeight} · scan ${state.scanW || 0}×${state.scanH || 0}${latency.factor < 0.99 ? ` (guard ${Math.round(latency.factor * 100)}%)` : ''} · ${workers.length} worker${workers.length > 1 ? 's' : ''}${bitmapPath ? '' : ' (no bitmaps)'}` + (state.events.length ? '\n' + state.events.join('\n') : '');
  }
  $('live').classList.toggle('live', !state.paused && state.detTimes.length > 0 && now - state.detTimes[state.detTimes.length - 1] < 500);
}

// One card per tag read so far: tiny tag, its ID, and how many frames it was read in.
// Cards are kept by ID and only their text and state change between renders.
const cards = new Map();
function renderSeen(inView = new Set()) {
  seenDirty = false;
  seenAt = performance.now();
  const list = $('seen');
  // Ordered by last seen: tags in view first (newest arrival on the left; they are all
  // "seen now", so ordering them by that would reshuffle every frame), then the rest by
  // when they were last in view, most recent first.
  const order = (id) => (inView.has(id) ? 1e12 + (state.entered.get(id) || 0) : lastSeenAt.get(id) || 0);
  const ids = [...state.seen.keys()].sort((a, b) => order(b) - order(a));
  $('seenCount').textContent = ids.length ? `${ids.length} marker${ids.length === 1 ? '' : 's'}` : 'No markers yet';
  $('emptyHint').hidden = ids.length > 0;
  for (const [id, el] of cards) if (!state.seen.has(id)) { el.remove(); cards.delete(id); }
  let prev = null;
  for (const id of ids) {
    let el = cards.get(id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'card';
      el.setAttribute('aria-label', `Copy ID ${id}`);
      el.onclick = () => copyId(id, el);
      el.style.setProperty('--c', color(id));
      el.innerHTML = '<span class="mini"></span><span class="meta"><b></b><small></small></span>';
      el.querySelector('b').textContent = id;
      el.mini = el.querySelector('.mini');
      el.count = el.querySelector('small');
      el.classList.add('new');
      el.addEventListener('animationend', () => el.classList.remove('new'), { once: true });
      cards.set(id, el);
      showCopyHint();
    }
    if (!el.mini.firstChild) el.mini.innerHTML = miniSvg(id);
    const n = state.seen.get(id);
    if (el.shownCount !== n && !el.flash) { el.shownCount = n; el.count.textContent = `${n} read${n === 1 ? '' : 's'}`; }
    el.classList.toggle('live', inView.has(id));
    // Keep DOM order sorted without re-inserting cards that are already in place.
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
}

// Tap a card to copy that marker's ID; the card says so in place of its read count.
async function copyId(id, el) {
  let msg = 'Copied';
  try { await navigator.clipboard.writeText(String(id)); } catch { msg = 'Copy failed'; }
  clearTimeout(el.flash);
  el.count.textContent = msg;
  el.classList.add('copied');
  el.flash = setTimeout(() => {
    el.flash = 0;
    el.classList.remove('copied');
    el.shownCount = null; // let the next render restore the read count
    seenDirty = true;
  }, 1200);
  $('copyHint').hidden = true;
}

// The first time a marker appears in the list on this phone, say it can be copied.
function showCopyHint() {
  if (store.get('copyHintSeen')) return;
  store.set('copyHintSeen', '1');
  $('copyHint').hidden = false;
  setTimeout(() => ($('copyHint').hidden = true), 3500);
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
  options($('family'), MARKER_FAMILIES.map((f) => [f, f.label]), state.family, (f) => {
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
    if (v === state.cam || state.switching) return;
    state.cam = v;
    store.set('cam', v);
    if (state.track) restartCamera();
  });
  const short = (l) => l.replace(/^back\s*/i, '').replace(/\s*camera$/i, '') || 'Wide';
  options($('lensOpts'), [['auto', 'Auto (steady)'], ...state.lenses.map((l) => [l.id, short(l.label)])], state.lens, (v) => {
    if (v === state.lens || state.switching) return;
    state.lens = v;
    store.set('lens', v);
    if (state.track) restartCamera();
  });
  $('lensGroup').hidden = !state.lenses.length;
  $('camNow').textContent = video.videoWidth ? `Camera ${Math.max(video.videoWidth, video.videoHeight)}×${Math.min(video.videoWidth, video.videoHeight)}` : '';
  options($('areaOpts'), AREA_OPTIONS, state.area, (v) => { state.area = v; store.set('area', v); });
  options($('correctOpts'), [[false, 'Off'], [true, 'On']], state.correct, (v) => {
    state.correct = v;
    store.set('correct', v ? '1' : '0');
  });
  options($('statOpts'), [[false, 'Off'], [true, 'On']], state.showStats, (v) => {
    state.showStats = v;
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
  dropInFlight();
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
  $('settingsDone').focus({ preventScroll: true });
}
function closeSettings() {
  if ($('settings').hidden) return;
  $('scrim').hidden = true;
  $('settings').hidden = true;
  $('settingsBtn').focus({ preventScroll: true });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

/* ---------- controls ---------- */

$('start').onclick = startCamera;
$('setBtn').onclick = openSettings;
$('settingsBtn').onclick = openSettings;
$('settingsDone').onclick = closeSettings;
$('scrim').onclick = closeSettings;
// Tap the picture to freeze it (to read IDs at leisure); tap again to resume. A pinch is
// not a tap, so zooming never freezes.
// The first time the camera opens on this phone, say how to pause.
function showTapHint() {
  if (store.get('tapHintSeen')) return;
  store.set('tapHintSeen', '1');
  $('tapHint').hidden = false;
  setTimeout(() => ($('tapHint').hidden = true), 2500);
}

function setFrozen(frozen) {
  $('tapHint').hidden = true;
  state.paused = frozen;
  $('frozen').hidden = !frozen;
  document.body.classList.toggle('paused', frozen);
  if (frozen) video.pause();
  else video.play().catch(() => {});
}
$('stage').onclick = () => { if (state.track) setFrozen(!state.paused); };
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
  state.entered.clear();
  lastSeenAt.clear();
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
    btn.textContent = text ? 'Copy failed' : 'Nothing to copy';
  }
  setTimeout(() => (btn.textContent = 'Copy IDs'), 1400);
};

/* ---------- marker display (to test from a second screen) ---------- */

const genSet = $('genSet');
for (const f of MARKER_FAMILIES) {
  for (const n of f.sizes || [null]) {
    const o = document.createElement('option');
    o.value = n ? `${f.key}|${n}` : f.key;
    o.textContent = setLabel(f, n);
    genSet.append(o);
  }
}

async function renderMarker() {
  const [fk, n] = genSet.value.split('|');
  const f = MARKER_FAMILIES.find((x) => x.key === fk);
  await loadDictionary(f.base);
  const dict = drawingDictionary(f.base);
  const max = (n ? +n : dict.codeList.length) - 1;
  const id = Math.max(0, Math.min(max, parseInt($('genId').value, 10) || 0));
  $('genId').value = id;
  $('genId').max = max;
  $('markerSvg').innerHTML = dict.generateSVG(id);
  $('markerCaption').textContent = `IDs 0 to ${max}`;
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

// Open straight into the reader. The start screen is only a splash while the camera
// starts; its buttons matter only if the camera can't start (access denied, no camera).
startCamera();

// Start screen: a real 4×4 marker that flips its cells from one ID to the next, the way
// the reader sees them. One cell wave every two seconds while the start screen shows.
(function startMarker() {
  const NS = 'http://www.w3.org/2000/svg';
  const quiet = document.createElementNS(NS, 'rect');
  quiet.setAttribute('class', 'quiet');
  quiet.setAttribute('width', 8); quiet.setAttribute('height', 8);
  const cells = Array.from({ length: 36 }, (_, i) => {
    const el = document.createElementNS(NS, 'rect');
    el.setAttribute('x', 1 + (i % 6)); el.setAttribute('y', 1 + ((i / 6) | 0));
    el.setAttribute('width', 1); el.setAttribute('height', 1);
    el.style.setProperty('--d', `${((i % 6) + ((i / 6) | 0)) * 22}ms`); // a diagonal wave
    return el;
  });
  $('mark').replaceChildren(quiet, ...cells);
  const show = (bits) => {
    cells.forEach((el, i) => {
      const x = i % 6, y = (i / 6) | 0;
      const inner = x > 0 && x < 5 && y > 0 && y < 5;
      el.classList.toggle('w', inner && bits[(y - 1) * 4 + (x - 1)] === '1');
    });
  };
  show('1011010100110010'); // DICT_4X4 ID 0, drawn before the dictionary loads
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ids = [0, 7, 23, 42, 3, 17, 31, 12];
  let k = 0;
  loadDictionary('ARUCO_4X4_1000').then(() => {
    const dict = drawingDictionary('ARUCO_4X4_1000');
    const timer = setInterval(() => {
      if ($('gate').hidden) { clearInterval(timer); return; }
      k = (k + 1) % ids.length;
      show(dict.codeList[ids[k]]);
    }, 2000);
  }, () => {});
})();

// Pages come from the network first (see sw.js), so a new release shows the next time the
// app is opened. The page never reloads itself: that would ask for the camera again.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
