'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let allPoints = [];   // [{lat, lon}, ...]
let currentDoc = null;
let currentFilename = '';
let trimStart = 0;
let trimEnd = 0;

// ── Map setup ─────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([20, 0], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// Three polylines: removed start, kept, removed end
const layers = { removedStart: null, kept: null, removedEnd: null };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const fileInput       = document.getElementById('file-input');
const controls        = document.getElementById('controls');
const totalCountEl    = document.getElementById('total-count');
const keepCountEl     = document.getElementById('keep-count');
const startSlider     = document.getElementById('trim-start-slider');
const startNum        = document.getElementById('trim-start-num');
const endSlider       = document.getElementById('trim-end-slider');
const endNum          = document.getElementById('trim-end-num');
const downloadBtn     = document.getElementById('download-btn');
const timeRemStartEl  = document.getElementById('time-removed-start');
const timeRemEndEl    = document.getElementById('time-removed-end');
const sidebarClose    = document.getElementById('sidebar-close');
const sidebarOpen     = document.getElementById('sidebar-open');
const backdrop        = document.getElementById('backdrop');
const fileSection     = document.querySelector('.file-section');
const fileToggle      = document.getElementById('file-toggle');

// ── Generic collapsible sections ──────────────────────────────────────────────
document.querySelectorAll('.section-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const section = btn.closest('.collapsible');
    if (!section) return;
    const collapsed = section.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
});

// ── Sidebar toggle ────────────────────────────────────────────────────────────
function closeSidebar() {
  document.body.classList.add('sidebar-hidden');
  sidebarOpen.innerHTML = '&#9776; Controls';
}
function openSidebar() {
  document.body.classList.remove('sidebar-hidden');
  sidebarOpen.innerHTML = '&#10005; Controls';
}
function toggleSidebar() {
  document.body.classList.contains('sidebar-hidden') ? openSidebar() : closeSidebar();
}

sidebarClose.addEventListener('click', closeSidebar);
sidebarOpen.addEventListener('click', toggleSidebar);
backdrop.addEventListener('click', closeSidebar);

// Start collapsed on mobile
if (window.innerWidth <= 640) closeSidebar();

// ── GPX parsing ───────────────────────────────────────────────────────────────
function loadGpxText(text, filename) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');

  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    alert('Could not parse GPX file — invalid XML.');
    return;
  }

  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  if (trkpts.length === 0) {
    alert('No track points (trkpt) found in this GPX file.');
    return;
  }

  allPoints = trkpts.map(pt => {
    const timeEl = pt.getElementsByTagName('time')[0];
    const t = timeEl ? Date.parse(timeEl.textContent) : NaN;
    return {
      lat: parseFloat(pt.getAttribute('lat')),
      lon: parseFloat(pt.getAttribute('lon')),
      time: isNaN(t) ? null : t,
    };
  });

  currentDoc = doc;
  currentFilename = filename;

  trimStart = 0;
  trimEnd = 0;
  resetControls();
  controls.hidden = false;
  downloadBtn.hidden = false;
  fileSection.classList.add('collapsed');
  fileToggle.setAttribute('aria-expanded', 'false');
  updateDisplay();
  updateMap();

  const bounds = L.latLngBounds(allPoints.map(p => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [20, 20] });
}

// ── Controls ──────────────────────────────────────────────────────────────────
function resetControls() {
  const max = allPoints.length - 1;
  for (const el of [startSlider, startNum, endSlider, endNum]) {
    el.max = max;
    el.value = 0;
  }
}

function setTrimStart(val) {
  const max = Math.max(0, allPoints.length - trimEnd - 1);
  trimStart = Math.max(0, Math.min(parseInt(val, 10) || 0, max));
  startSlider.value = trimStart;
  startNum.value = trimStart;
  updateDisplay();
  updateMap();
}

function setTrimEnd(val) {
  const max = Math.max(0, allPoints.length - trimStart - 1);
  trimEnd = Math.max(0, Math.min(parseInt(val, 10) || 0, max));
  endSlider.value = trimEnd;
  endNum.value = trimEnd;
  updateDisplay();
  updateMap();
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function timeBetween(i, j) {
  if (i < 0 || j >= allPoints.length || i >= j) return null;
  const a = allPoints[i].time, b = allPoints[j].time;
  if (a == null || b == null) return null;
  return b - a;
}

function updateDisplay() {
  const total = allPoints.length;
  const kept = total - trimStart - trimEnd;
  totalCountEl.textContent = `${total.toLocaleString()} points total`;

  if (trimStart === 0 && trimEnd === 0) {
    keepCountEl.textContent = 'Keeping all points';
    keepCountEl.classList.remove('trimming');
  } else {
    const removed = trimStart + trimEnd;
    keepCountEl.textContent = `Keeping ${kept.toLocaleString()} of ${total.toLocaleString()} (−${removed})`;
    keepCountEl.classList.add('trimming');
  }

  // Time removed labels (only if GPX has timestamps)
  if (trimStart > 0) {
    const ms = timeBetween(0, trimStart);
    timeRemStartEl.textContent = ms != null ? `−${formatDuration(ms)} removed` : '';
  } else {
    timeRemStartEl.textContent = '';
  }

  if (trimEnd > 0) {
    const ms = timeBetween(total - trimEnd - 1, total - 1);
    timeRemEndEl.textContent = ms != null ? `−${formatDuration(ms)} removed` : '';
  } else {
    timeRemEndEl.textContent = '';
  }
}

// ── Map rendering ─────────────────────────────────────────────────────────────
function updateMap() {
  for (const key of Object.keys(layers)) {
    if (layers[key]) { map.removeLayer(layers[key]); layers[key] = null; }
  }

  const total = allPoints.length;
  const endIdx = trimEnd > 0 ? total - trimEnd : total;
  const toLL = p => [p.lat, p.lon];

  const removedStartPts = allPoints.slice(0, trimStart);
  const keptPts         = allPoints.slice(trimStart, endIdx);
  const removedEndPts   = allPoints.slice(endIdx);

  if (removedStartPts.length >= 2) {
    layers.removedStart = L.polyline(removedStartPts.map(toLL), {
      color: '#e74c3c', weight: 4, opacity: 0.85,
    }).addTo(map);
  }
  if (keptPts.length >= 2) {
    layers.kept = L.polyline(keptPts.map(toLL), {
      color: '#2196F3', weight: 4, opacity: 0.9,
    }).addTo(map);
  }
  if (removedEndPts.length >= 2) {
    layers.removedEnd = L.polyline(removedEndPts.map(toLL), {
      color: '#e74c3c', weight: 4, opacity: 0.85,
    }).addTo(map);
  }
}

// ── Download (fully client-side) ──────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  if (!currentDoc) return;

  const doc = currentDoc.cloneNode(true);
  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  const total = trkpts.length;
  const endIdx = trimEnd > 0 ? total - trimEnd : total;

  // Remove end first so start indices stay valid
  for (let i = total - 1; i >= endIdx; i--) {
    trkpts[i].parentNode.removeChild(trkpts[i]);
  }
  for (let i = trimStart - 1; i >= 0; i--) {
    trkpts[i].parentNode.removeChild(trkpts[i]);
  }

  const xmlStr = new XMLSerializer().serializeToString(doc);
  const blob = new Blob([xmlStr], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = currentFilename.replace(/\.gpx$/i, '_trimmed.gpx') || 'trimmed.gpx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ── Event wiring ──────────────────────────────────────────────────────────────
fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  readFile(file);
});

startSlider.addEventListener('input', e => setTrimStart(e.target.value));
startNum.addEventListener('input',   e => setTrimStart(e.target.value));
endSlider.addEventListener('input',  e => setTrimEnd(e.target.value));
endNum.addEventListener('input',     e => setTrimEnd(e.target.value));

document.addEventListener('click', e => {
  const btn = e.target.closest('.btn-step');
  if (!btn || !allPoints.length) return;
  const delta = parseInt(btn.dataset.delta, 10);
  if (btn.dataset.target === 'start') setTrimStart(trimStart + delta);
  else                                setTrimEnd(trimEnd + delta);
});

// ── Drag-and-drop ─────────────────────────────────────────────────────────────
function readFile(file) {
  const reader = new FileReader();
  reader.onload = e => loadGpxText(e.target.result, file.name);
  reader.readAsText(file);
}

document.addEventListener('dragover', e => {
  e.preventDefault();
  document.body.classList.add('drag-over');
});
document.addEventListener('dragleave', e => {
  if (e.relatedTarget === null) document.body.classList.remove('drag-over');
});
document.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.gpx')) readFile(file);
  else if (file) alert('Please drop a .gpx file.');
});
