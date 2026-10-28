// Marker sets, shared by the reader, its detection worker, the sheet generator and the
// speed test. A plain script (no modules) so the worker can importScripts it.
// Needs vendor/aruco.js loaded first.

// OpenCV's DICT_NxN_50/100/250 are the first codes of DICT_NxN_1000; smaller sets leave
// more room between codes, so fewer random patterns can match one.
// `key` is stored in localStorage (and read by the sheet generator); `label` is shown.
const MARKER_FAMILIES = [
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

const DICTIONARY_FILES = {
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
const dictionaryUrl = (base) => `vendor/dictionaries/${DICTIONARY_FILES[base]}.js`;

// The detector's key for a set ("ARUCO_4X4_1000:50") and OpenCV's name ("DICT_4X4_50").
const setKeyOf = (family, size) => (family.sizes ? `${family.base}:${size}` : family.base);
const setNameOf = (family, size) => (family.sizes ? `${family.name}_${size}` : family.name);

// Every set as a flat list, in picker order.
const MARKER_SETS = MARKER_FAMILIES.flatMap((f) => (f.sizes || [null]).map((size) => ({
  family: f, size, name: setNameOf(f, size), base: f.base, count: size,
})));

// Loads a dictionary file once. In a worker it blocks (importScripts); on a page it
// resolves when the script has run, and a failed load can be retried.
const dictionaryLoads = {};
function loadDictionary(base) {
  if (AR.DICTIONARIES[base]) return Promise.resolve();
  if (typeof document === 'undefined') {
    importScripts(dictionaryUrl(base));
    return Promise.resolve();
  }
  return dictionaryLoads[base] || (dictionaryLoads[base] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = dictionaryUrl(base);
    s.onload = resolve;
    s.onerror = () => { delete dictionaryLoads[base]; s.remove(); reject(new Error(`Could not load ${base}`)); };
    document.head.append(s);
  }));
}

// A dictionary for drawing markers (not detecting). Building one normally scans every pair
// of codes for their minimum distance, which drawing does not need; skip it.
const drawingDictionaries = {};
function drawingDictionary(base) {
  if (drawingDictionaries[base]) return drawingDictionaries[base];
  const def = AR.DICTIONARIES[base], saved = def.tau;
  def.tau = 1;
  try { return (drawingDictionaries[base] = new AR.Dictionary(base)); } finally { def.tau = saved; }
}
