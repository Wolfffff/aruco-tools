const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

/* ---------- marker sets ---------- */

// OpenCV's DICT_NxN_50/100/250 are the first codes of DICT_NxN_1000; smaller sets
// leave more room between codes, so the worker can correct more bit errors.
const FAMILIES = [
  { key: '4x4', base: 'ARUCO_4X4_1000', name: 'DICT_4X4', sizes: [50, 100, 250, 1000] },
  { key: '5x5', base: 'ARUCO_5X5_1000', name: 'DICT_5X5', sizes: [50, 100, 250, 1000] },
  { key: '6x6', base: 'ARUCO_6X6_1000', name: 'DICT_6X6', sizes: [50, 100, 250, 1000] },
  { key: '7x7', base: 'ARUCO_7X7_1000', name: 'DICT_7X7', sizes: [50, 100, 250, 1000] },
  { key: 'Original', base: 'ARUCO_DEFAULT_OPENCV', name: 'DICT_ARUCO_ORIGINAL' },
  { key: 'MIP 36h12', base: 'ARUCO_MIP_36h12', name: 'DICT_ARUCO_MIP_36h12' },
  { key: 'April 16h5', base: 'APRILTAG_16h5', name: 'DICT_APRILTAG_16h5' },
  { key: 'April 25h9', base: 'APRILTAG_25h9', name: 'DICT_APRILTAG_25h9' },
  { key: 'April 36h11', base: 'APRILTAG_36h11', name: 'DICT_APRILTAG_36h11' },
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
const RES_STEPS = [480, 640, 960, 1280];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  family: FAMILIES.find((f) => f.key === store.get('family')) || FAMILIES[0],
  size: +(store.get('size') || 50),
  res: +(store.get('res') || 640),
  area: ['full', 'auto', 'center'].includes(store.get('area')) ? store.get('area') : 'auto',
  flip: false, // in auto mode, alternates full-frame and center passes
  paused: false,
  busy: false,
  pending: false,
  loopsStarted: false,
  track: null,
  seen: new Map(), // id -> frames seen
  tracks: new Map(), // id -> { corners, at } for drawing with smoothing and fade
  frameTimes: [],
  lastMs: 0,
};

function setKey(f = state.family, size = state.size) {
  return f.sizes ? `${f.base}:${size}` : f.base;
}
function setLabel(f = state.family, size = state.size) {
  return f.sizes ? `${f.name}_${size}` : f.name;
}

// Same ID always gets the same colour, so you can follow a tag across frames.
const hue = (id) => (id * 137.508 + 200) % 360;
const color = (id, a = 1) => `hsl(${hue(id)} 100% 62% / ${a})`;

/* ---------- camera ---------- */

async function startCamera() {
  $('err').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    return showError('No camera access on this page. Open it over https in Safari or Chrome.');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
    });
    video.srcObject = stream;
    await video.play();
    state.track = stream.getVideoTracks()[0];
    setupTrackControls();
    $('gate').hidden = true;
    $('top').hidden = false;
    $('panel').hidden = false;
    requestWakeLock();
    startLoops();
  } catch (e) {
    showError(e.name === 'NotAllowedError'
      ? 'Camera access was denied. Allow it for this site in your browser settings and reload.'
      : 'Could not open the camera: ' + (e.message || e.name));
  }
}

function setupTrackControls() {
  const caps = state.track.getCapabilities?.() || {};
  const adv = {};
  if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
  if (caps.exposureMode?.includes('continuous')) adv.exposureMode = 'continuous';
  if (Object.keys(adv).length) state.track.applyConstraints({ advanced: [adv] }).catch(() => {});
  $('torch').hidden = !caps.torch;
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const z = $('zoom');
    z.min = caps.zoom.min;
    z.max = Math.min(caps.zoom.max, 10);
    z.step = caps.zoom.step || 0.1;
    z.value = state.track.getSettings?.().zoom || caps.zoom.min;
    $('zoomVal').textContent = (+z.value).toFixed(1) + '×';
    $('zoomWrap').hidden = false;
  }
}

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
  state.track?.stop();
  state.track = null;
  state.busy = false;
  await startCamera();
}

/* ---------- detection ---------- */

const worker = new Worker('worker.js');

// The part of the video frame being scanned, in video pixels. The center crop is a
// 2x digital zoom at the same cost, which is what reads small or distant tags.
function scanRect(vw, vh, center) {
  if (!center) return { x: 0, y: 0, w: vw, h: vh };
  const w = Math.round(vw * 0.5), h = Math.round(vh * 0.5);
  return { x: (vw - w) >> 1, y: (vh - h) >> 1, w, h };
}

function sendFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || video.readyState < 2) return;
  state.flip = !state.flip;
  const center = state.area === 'center' || (state.area === 'auto' && state.flip);
  const r = scanRect(vw, vh, center);
  const scale = Math.min(1, state.res / Math.max(r.w, r.h));
  const w = Math.round(r.w * scale), h = Math.round(r.h * scale);
  if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
  gctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const img = gctx.getImageData(0, 0, w, h);
  state.busy = true;
  worker.postMessage(
    { width: w, height: h, buffer: img.data.buffer, dict: setKey(), roi: { x: r.x, y: r.y, scale } },
    [img.data.buffer],
  );
}

worker.onmessage = (e) => {
  state.busy = false;
  // A camera frame arrived while we were busy: process it right away.
  if (state.pending) { state.pending = false; sendFrame(); }
  const { markers, ms, error } = e.data;
  if (error) { console.error(error); return; }
  if (state.paused) return;
  const now = performance.now();
  for (const m of markers) {
    const t = state.tracks.get(m.id);
    // Light smoothing kills jitter without visible lag at detection rates.
    if (t && now - t.at < 150) {
      t.corners = t.corners.map((p, i) => [p[0] * 0.35 + m.corners[i][0] * 0.65, p[1] * 0.35 + m.corners[i][1] * 0.65]);
      t.at = now;
    } else {
      state.tracks.set(m.id, { corners: m.corners, at: now, born: now });
    }
  }
  updateLists(markers);
  state.lastMs = ms;
  const ft = state.frameTimes;
  ft.push(now);
  while (ft.length && now - ft[0] > 1000) ft.shift();
};

// Detection is driven by new camera frames, so each frame is processed at most once
// and nothing is wasted re-reading a frame the camera has not replaced yet.
// While the worker is busy we only remember that a newer frame is waiting.
function onVideoFrame() {
  if (state.paused) return;
  if (state.busy) state.pending = true;
  else sendFrame();
}

function startLoops() {
  if (state.loopsStarted) return;
  state.loopsStarted = true;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const tick = () => { onVideoFrame(); video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  } else {
    let lastTime = -1;
    const tick = () => {
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; onVideoFrame(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const paint = () => {
    draw();
    if (!state.paused) renderStats();
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
}

/* ---------- drawing ---------- */

function draw() {
  const dpr = Math.min(devicePixelRatio || 1, 2); // 3x overlays cost fill-rate on big phones for no visible gain
  const cw = Math.round(overlay.clientWidth * dpr), ch = Math.round(overlay.clientHeight * dpr);
  if (overlay.width !== cw || overlay.height !== ch) { overlay.width = cw; overlay.height = ch; }
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, cw, ch);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;

  // Map video pixels to the screen the same way object-fit: cover does.
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const P = (p) => [p[0] * s + ox, p[1] * s + oy];

  if (state.area === 'center') drawScanArea(scanRect(vw, vh, true), P, dpr);

  const now = performance.now();
  for (const [id, t] of state.tracks) {
    const age = now - t.at;
    if (age > 400) { state.tracks.delete(id); continue; }
    const alpha = state.paused ? 1 : age < 120 ? 1 : 1 - (age - 120) / 280;
    drawMarker(id, t.corners.map(P), alpha, dpr, Math.min(1, (now - t.born) / 120));
  }
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
  const L = Math.min(x1 - x0, y1 - y0) * 0.12;
  brackets([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], L);
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

function drawMarker(id, q, alpha, dpr, grow) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const side = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;

  octx.lineJoin = 'round';
  octx.lineCap = 'round';

  // Tinted fill + outline on the tag itself.
  octx.globalAlpha = alpha;
  octx.fillStyle = color(id, 0.28);
  octx.strokeStyle = color(id);
  octx.lineWidth = 3 * dpr;
  octx.beginPath();
  octx.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < 4; i++) octx.lineTo(q[i][0], q[i][1]);
  octx.closePath();
  octx.fill();
  octx.stroke();

  // Lock-on brackets just outside the tag; they snap in when a tag is first found.
  const pad = 1 + 0.18 + (1 - grow) * 0.25;
  const outer = q.map((p) => [cx + (p[0] - cx) * pad, cy + (p[1] - cy) * pad]);
  const bl = Math.max(10 * dpr, side * 0.22);
  octx.lineWidth = 7 * dpr;
  octx.strokeStyle = 'rgba(0,0,0,0.55)';
  brackets(outer, bl);
  octx.lineWidth = 4 * dpr;
  octx.strokeStyle = color(id);
  brackets(outer, bl);

  // Corner 0 is the tag's own top-left: shows which way it faces.
  octx.fillStyle = '#fff';
  octx.beginPath();
  octx.arc(q[0][0], q[0][1], 4 * dpr, 0, Math.PI * 2);
  octx.fill();

  // ID label above the tag.
  const fs = Math.max(16 * dpr, Math.min(40 * dpr, side * 0.32));
  octx.font = `700 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
  const label = String(id);
  const tw = octx.measureText(label).width;
  const top = Math.min(outer[0][1], outer[1][1], outer[2][1], outer[3][1]);
  const lx = cx, ly = Math.max(fs, top - fs * 0.75);
  const padX = fs * 0.35, h = fs * 1.25;
  octx.fillStyle = color(id);
  roundRect(lx - tw / 2 - padX, ly - h / 2, tw + padX * 2, h, h * 0.25);
  octx.fill();
  octx.fillStyle = '#000';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(label, lx, ly + fs * 0.04);
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

let lastNowKey = null;
let seenRenderAt = 0;
function updateLists(markers) {
  const ids = [...new Set(markers.map((m) => m.id))].sort((a, b) => a - b);
  let fresh = false;
  for (const id of ids) {
    if (!state.seen.has(id)) fresh = true;
    state.seen.set(id, (state.seen.get(id) || 0) + 1);
  }
  if (fresh) navigator.vibrate?.(12);

  const key = ids.join(',');
  if (key !== lastNowKey) {
    lastNowKey = key;
    const el = $('now');
    el.replaceChildren();
    if (!ids.length) {
      const s = document.createElement('span');
      s.className = 'none';
      s.textContent = 'Point at a tag';
      el.append(s);
    }
    for (const id of ids) {
      const s = document.createElement('span');
      s.className = 'id';
      s.style.color = color(id);
      s.textContent = id;
      el.append(s);
    }
  }
  const now = performance.now();
  if (fresh || (ids.length && now - seenRenderAt > 300)) renderSeen();
}

function renderSeen() {
  seenRenderAt = performance.now();
  const el = $('seen');
  el.replaceChildren();
  const rows = [...state.seen.entries()].sort((a, b) => a[0] - b[0]);
  if (!rows.length) {
    const s = document.createElement('span');
    s.className = 'tag';
    s.textContent = '—';
    el.append(s);
  }
  for (const [id, n] of rows) {
    const s = document.createElement('span');
    s.className = 'tag';
    s.style.setProperty('--c', color(id));
    s.textContent = id;
    const b = document.createElement('b');
    b.textContent = n;
    s.append(b);
    el.append(s);
  }
}

let statAt = 0;
function renderStats() {
  const now = performance.now();
  if (now - statAt < 250) return;
  statAt = now;
  $('stat').textContent = `${state.frameTimes.length} fps · ${state.lastMs.toFixed(1)} ms · ${grab.width}×${grab.height}`;
  $('live').classList.toggle('live', state.frameTimes.length > 0);
}

/* ---------- controls ---------- */

function renderSetPicker() {
  const fam = $('family');
  fam.replaceChildren();
  for (const f of FAMILIES) {
    const b = document.createElement('button');
    b.textContent = f.key;
    b.setAttribute('aria-pressed', f === state.family);
    b.onclick = () => {
      state.family = f;
      store.set('family', f.key);
      onSetChange();
    };
    fam.append(b);
  }
  const size = $('size');
  size.replaceChildren();
  size.hidden = !state.family.sizes;
  for (const n of state.family.sizes || []) {
    const b = document.createElement('button');
    b.textContent = '_' + n;
    b.setAttribute('aria-pressed', n === state.size);
    b.onclick = () => {
      state.size = n;
      store.set('size', String(n));
      onSetChange();
    };
    size.append(b);
  }
  $('setName').textContent = setLabel();
}

function onSetChange() {
  state.tracks.clear();
  state.seen.clear();
  lastNowKey = null;
  updateLists([]);
  renderSeen();
  renderSetPicker();
}

function renderToolLabels() {
  $('res').textContent = state.res + 'p';
  $('area').textContent = { full: 'Full frame', auto: 'Auto range', center: 'Far (2×)' }[state.area];
}

$('start').onclick = startCamera;
$('setBtn').onclick = () => {
  const open = $('sets').hidden;
  $('sets').hidden = !open;
  $('setBtn').setAttribute('aria-expanded', open);
};
$('area').onclick = () => {
  const modes = ['auto', 'center', 'full'];
  state.area = modes[(modes.indexOf(state.area) + 1) % modes.length];
  store.set('area', state.area);
  renderToolLabels();
};
$('res').onclick = () => {
  state.res = RES_STEPS[(RES_STEPS.indexOf(state.res) + 1) % RES_STEPS.length];
  store.set('res', String(state.res));
  renderToolLabels();
};
$('pause').onclick = (e) => {
  state.paused = !state.paused;
  e.currentTarget.setAttribute('aria-pressed', state.paused);
  e.currentTarget.textContent = state.paused ? 'Live' : 'Freeze';
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
$('zoom').oninput = (e) => {
  const z = +e.target.value;
  $('zoomVal').textContent = z.toFixed(1) + '×';
  state.track?.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
};
$('clear').onclick = () => {
  state.seen.clear();
  renderSeen();
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
    btn.textContent = text ? 'Copy failed' : 'Nothing yet';
  }
  setTimeout(() => (btn.textContent = 'Copy'), 1400);
};

/* ---------- marker sheet (to test from a second screen) ---------- */

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

if (state.family.sizes && !state.family.sizes.includes(state.size)) state.size = state.family.sizes[0];
renderSetPicker();
renderToolLabels();
updateLists([]);
renderSeen();

// Start-screen emblem: a real DICT_4X4 marker, id 0.
$('mark').innerHTML = Array.from({ length: 36 }, (_, i) => {
  const x = i % 6, y = (i / 6) | 0;
  const inner = x > 0 && x < 5 && y > 0 && y < 5;
  return `<i class="${inner && '1011010100110010'[(y - 1) * 4 + (x - 1)] === '1' ? 'w' : ''}"></i>`;
}).join('');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
