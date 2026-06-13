'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let allPoints = [];           // [{lat, lon, time}, ...]
let currentDoc = null;
let currentFilename = '';
let trimStart = 0;
let trimEnd = 0;
let removedSet = new Set();   // indices marked for spot removal
let cursorIdx = 0;
let units = localStorage.getItem('gpx-units') || 'metric';  // 'metric' | 'imperial'
let hrLoaded = false;         // true once HR from a .fit has been merged in

// Garmin TrackPointExtension namespace — how GPX carries per-point HR.
const GPXTPX_NS = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
// Max time gap (ms) allowed when matching a GPX point to a FIT HR sample.
const HR_MATCH_TOLERANCE_MS = 10000;

// ── Map setup ─────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([20, 0], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// Dynamic list of layers added to the map (cleared on each render)
let mapLayers = [];
function clearLayers() {
  mapLayers.forEach(l => map.removeLayer(l));
  mapLayers = [];
}
function addLayer(layer) {
  layer.addTo(map);
  mapLayers.push(layer);
}

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
const cursorSlider    = document.getElementById('cursor-slider');
const cursorNum       = document.getElementById('cursor-num');
const sidebarEl       = document.getElementById('sidebar');
const markBtn         = document.getElementById('mark-btn');
const unmarkBtn       = document.getElementById('unmark-btn');
const clearBtn        = document.getElementById('clear-btn');
const spotCountEl     = document.getElementById('spot-count');
const infoEleEl       = document.getElementById('info-ele');
const infoTimeEl      = document.getElementById('info-time');
const infoPrevEl      = document.getElementById('info-prev');
const infoNextEl      = document.getElementById('info-next');
const markedListWrap  = document.querySelector('.marked-list-wrap');
const markedListEl    = document.getElementById('marked-list');
const markedCountInlineEl = document.getElementById('marked-count-inline');
const fitInput        = document.getElementById('fit-input');
const hrStatusEl      = document.getElementById('hr-status');
const hrClearBtn      = document.getElementById('hr-clear-btn');

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

// ── Unit toggle (metric / imperial) ───────────────────────────────────────────
function setUnits(u) {
  units = u === 'imperial' ? 'imperial' : 'metric';
  localStorage.setItem('gpx-units', units);
  document.querySelectorAll('.unit-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.unit === units);
  });
  if (allPoints.length > 0) {
    updateDisplay();
    renderMarkedList();
  }
}
document.querySelectorAll('.unit-btn').forEach(btn => {
  btn.addEventListener('click', () => setUnits(btn.dataset.unit));
});
setUnits(units);

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
    const eleEl  = pt.getElementsByTagName('ele')[0];
    const t = timeEl ? Date.parse(timeEl.textContent) : NaN;
    const e = eleEl ? parseFloat(eleEl.textContent) : NaN;
    return {
      lat: parseFloat(pt.getAttribute('lat')),
      lon: parseFloat(pt.getAttribute('lon')),
      time: isNaN(t) ? null : t,
      ele:  isNaN(e) ? null : e,
    };
  });

  currentDoc = doc;
  currentFilename = filename;

  trimStart = 0;
  trimEnd = 0;
  removedSet = new Set();
  cursorIdx = 0;
  resetHr();
  resetControls();
  controls.hidden = false;
  downloadBtn.hidden = false;
  document.getElementById('save-btn').hidden = false;
  document.getElementById('save-status').hidden = true;
  fileSection.classList.add('collapsed');
  fileToggle.setAttribute('aria-expanded', 'false');
  updateDisplay();
  updateMap();

  const bounds = L.latLngBounds(allPoints.map(p => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [20, 20] });
}

// ── Controls ──────────────────────────────────────────────────────────────────
function resetControls() {
  const max = Math.max(0, allPoints.length - 1);
  for (const el of [startSlider, startNum, endSlider, endNum, cursorSlider, cursorNum]) {
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

// Pixel-rect of the map area not covered by the mobile bottom panel.
function visibleMapRect() {
  const c = map.getContainer();
  const isMobile = window.innerWidth <= 640;
  const panelOpen = !document.body.classList.contains('sidebar-hidden');
  const bottomCovered = (isMobile && panelOpen) ? sidebarEl.offsetHeight : 0;
  return { w: c.clientWidth, h: c.clientHeight, bottomCovered };
}

function isLatLngVisible(latLng) {
  const { w, h, bottomCovered } = visibleMapRect();
  const pt = map.latLngToContainerPoint(latLng);
  const m = 32; // edge padding
  return pt.x > m && pt.x < w - m && pt.y > m && pt.y < h - bottomCovered - m;
}

// panTo, but offsets the target downward so it ends up centered in the
// area NOT covered by the bottom panel.
function panToVisible(latLng) {
  const { bottomCovered } = visibleMapRect();
  if (bottomCovered === 0) { map.panTo(latLng); return; }
  const targetPt = map.project(latLng);
  map.panTo(map.unproject(targetPt.add([0, bottomCovered / 2])));
}

function setCursor(val, { pan = false } = {}) {
  const max = Math.max(0, allPoints.length - 1);
  cursorIdx = Math.max(0, Math.min(parseInt(val, 10) || 0, max));
  cursorSlider.value = cursorIdx;
  cursorNum.value = cursorIdx;
  if (pan && allPoints[cursorIdx]) {
    const p = allPoints[cursorIdx];
    const ll = L.latLng(p.lat, p.lon);
    if (!isLatLngVisible(ll)) panToVisible(ll);
  }
  updateDisplay();
  updateMap();
}

function isRemoved(idx) {
  const total = allPoints.length;
  if (idx < trimStart) return true;
  if (idx >= total - trimEnd) return true;
  return removedSet.has(idx);
}

function formatDuration(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Great-circle distance in meters between two GPS points
function haversineMeters(p1, p2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const lat1 = toRad(p1.lat), lat2 = toRad(p2.lat);
  const dLat = toRad(p2.lat - p1.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const M_TO_FT = 3.28084;
const M_TO_MI = 0.000621371;

function formatDistance(m) {
  if (m == null || isNaN(m)) return '—';
  if (units === 'imperial') {
    const ft = m * M_TO_FT;
    if (ft < 5280) return `${ft.toFixed(0)} ft`;
    return `${(m * M_TO_MI).toFixed(2)} mi`;
  }
  if (m < 1000) return `${m.toFixed(1)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function formatElevation(m) {
  if (m == null || isNaN(m)) return '—';
  if (units === 'imperial') return `${(m * M_TO_FT).toFixed(0)} ft`;
  return `${m.toFixed(1)} m`;
}

function formatNeighbor(here, other) {
  if (!other) return '—';
  const dist = formatDistance(haversineMeters(here, other));
  const dt = (here.time != null && other.time != null)
    ? formatDuration(Math.abs(other.time - here.time))
    : '';
  return dt ? `${dist} · ${dt}` : dist;
}

function formatRelativeTime(deltaMs) {
  if (deltaMs == null || isNaN(deltaMs)) return '—';
  if (deltaMs === 0) return '0s';
  if (deltaMs < 0) {
    const s = formatDuration(-deltaMs);
    return s ? `−${s}` : '0s';
  }
  return formatDuration(deltaMs) || '0s';
}

function renderMarkedList() {
  const count = removedSet.size;
  markedCountInlineEl.textContent = count;

  if (count === 0) {
    markedListEl.innerHTML = '<div class="marked-empty">No points marked yet.</div>';
    return;
  }

  const startTime = allPoints[trimStart] ? allPoints[trimStart].time : null;
  const sorted = [...removedSet].sort((a, b) => a - b);

  const html = sorted.map(idx => {
    const p = allPoints[idx];
    if (!p) return '';
    const rel = (startTime != null && p.time != null) ? p.time - startTime : null;
    const timeStr = formatRelativeTime(rel);
    const eleStr  = formatElevation(p.ele);
    const cur = idx === cursorIdx ? ' current' : '';
    return `<div class="marked-row${cur}" data-idx="${idx}">`
         +   `<span class="marked-idx">#${idx.toLocaleString()}</span>`
         +   `<span class="marked-time">${timeStr}</span>`
         +   `<span class="marked-ele">${eleStr}</span>`
         +   `<button class="marked-unmark" data-unmark-idx="${idx}" title="Unmark">&times;</button>`
         + `</div>`;
  }).join('');

  markedListEl.innerHTML = html;
}

markedListEl.addEventListener('click', e => {
  const x = e.target.closest('.marked-unmark');
  if (x) {
    e.stopPropagation();
    const idx = parseInt(x.dataset.unmarkIdx, 10);
    removedSet.delete(idx);
    updateDisplay();
    updateMap();
    return;
  }
  const row = e.target.closest('.marked-row');
  if (row) {
    const idx = parseInt(row.dataset.idx, 10);
    setCursor(idx, { pan: true });
  }
});

function timeBetween(i, j) {
  if (i < 0 || j >= allPoints.length || i >= j) return null;
  const a = allPoints[i].time, b = allPoints[j].time;
  if (a == null || b == null) return null;
  return b - a;
}

function updateDisplay() {
  const total = allPoints.length;

  // Count removed via union of trim ranges + removedSet
  let removed = trimStart + trimEnd;
  removedSet.forEach(idx => {
    if (idx >= trimStart && idx < total - trimEnd) removed++;
  });
  const kept = Math.max(0, total - removed);

  totalCountEl.textContent = `${total.toLocaleString()} points total`;

  if (removed === 0) {
    keepCountEl.textContent = 'Keeping all points';
    keepCountEl.classList.remove('trimming');
  } else {
    keepCountEl.textContent = `Keeping ${kept.toLocaleString()} of ${total.toLocaleString()} (−${removed})`;
    keepCountEl.classList.add('trimming');
  }

  // Cursor stat
  spotCountEl.textContent = total > 0
    ? `Cursor at point ${cursorIdx.toLocaleString()} of ${total.toLocaleString()}`
    : 'No track loaded';
  spotCountEl.classList.toggle('has-marks', removedSet.size > 0);

  // Marked-points list (sub-collapsible)
  renderMarkedList();

  // Cursor info: elevation, relative time, neighbor distance/time
  const here = allPoints[cursorIdx];
  if (here) {
    const startTime = allPoints[trimStart] ? allPoints[trimStart].time : null;
    const relTime = (startTime != null && here.time != null) ? here.time - startTime : null;
    infoEleEl.textContent  = formatElevation(here.ele);
    infoTimeEl.textContent = formatRelativeTime(relTime);
    infoPrevEl.textContent = cursorIdx > 0
      ? formatNeighbor(here, allPoints[cursorIdx - 1]) : '—';
    infoNextEl.textContent = cursorIdx < total - 1
      ? formatNeighbor(here, allPoints[cursorIdx + 1]) : '—';
  } else {
    infoEleEl.textContent = infoTimeEl.textContent =
      infoPrevEl.textContent = infoNextEl.textContent = '—';
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
  clearLayers();
  const total = allPoints.length;
  if (total === 0) return;
  const toLL = p => [p.lat, p.lon];

  // 1) Red segments — consecutive runs of removed points
  let segStart = -1;
  for (let i = 0; i <= total; i++) {
    const removed = i < total && isRemoved(i);
    if (removed && segStart < 0) segStart = i;
    if (!removed && segStart >= 0) {
      const pts = allPoints.slice(segStart, i);
      if (pts.length >= 2) {
        addLayer(L.polyline(pts.map(toLL), {
          color: '#e74c3c', weight: 5, opacity: 0.85,
          interactive: false,
        }));
      }
      segStart = -1;
    }
  }

  // 2) Blue line — kept points only (the resulting cleaned track)
  const keptPts = [];
  for (let i = 0; i < total; i++) {
    if (!isRemoved(i)) keptPts.push(allPoints[i]);
  }
  if (keptPts.length >= 2) {
    addLayer(L.polyline(keptPts.map(toLL), {
      color: '#2196F3', weight: 4, opacity: 0.95,
      interactive: false,
    }));
  }

  // 3) Red dots — individually-marked points (only those NOT in trim ranges)
  removedSet.forEach(idx => {
    if (idx < trimStart || idx >= total - trimEnd) return;
    const p = allPoints[idx];
    if (!p) return;
    addLayer(L.circleMarker(toLL(p), {
      radius: 4, color: '#fff', fillColor: '#e74c3c',
      fillOpacity: 1, weight: 1.5, interactive: false,
    }));
  });

  // 4) Cursor marker — bright yellow dot at the current cursor point
  const cp = allPoints[cursorIdx];
  if (cp) {
    addLayer(L.circleMarker(toLL(cp), {
      radius: 7, color: '#000', fillColor: '#FFEB3B',
      fillOpacity: 1, weight: 2, interactive: false,
    }));
  }
}

// ── Nearest-point lookup (for map click) ─────────────────────────────────────
function nearestPointIndex(lat, lng) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < allPoints.length; i++) {
    const dLat = allPoints[i].lat - lat;
    const dLon = allPoints[i].lon - lng;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

map.on('click', e => {
  if (allPoints.length === 0) return;
  setCursor(nearestPointIndex(e.latlng.lat, e.latlng.lng));
});

// ── Heart-rate merge (from a separate .fit file) ──────────────────────────────
function resetHr() {
  hrLoaded = false;
  allPoints.forEach(p => { p.hr = null; });
  if (fitInput) fitInput.value = '';
  if (hrStatusEl) { hrStatusEl.hidden = true; hrStatusEl.textContent = ''; hrStatusEl.className = 'hr-status'; }
  if (hrClearBtn) hrClearBtn.hidden = true;
}

// Match each GPX point to the nearest FIT HR sample (within tolerance) by time.
// Both arrays are time-ascending; we binary-search per point for clarity.
function mergeHrSamples(samples) {
  const times = samples.map(s => s.t);
  let matched = 0;
  for (const p of allPoints) {
    p.hr = null;
    if (p.time == null || times.length === 0) continue;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < p.time) lo = mid + 1; else hi = mid;
    }
    let best = lo, bestD = Math.abs(times[lo] - p.time);
    if (lo > 0) {
      const d = Math.abs(times[lo - 1] - p.time);
      if (d < bestD) { best = lo - 1; bestD = d; }
    }
    if (bestD <= HR_MATCH_TOLERANCE_MS) { p.hr = samples[best].hr; matched++; }
  }
  return matched;
}

function showHrStatus(msg, kind) {
  hrStatusEl.hidden = false;
  hrStatusEl.textContent = msg;
  hrStatusEl.className = 'hr-status' + (kind ? ' ' + kind : '');
}

async function loadFitFile(file) {
  if (!allPoints.length) { alert('Load a GPX file first.'); return; }
  showHrStatus('Parsing .fit…', '');
  hrClearBtn.hidden = true;

  const form = new FormData();
  form.append('fit', file);

  let data;
  try {
    const resp = await fetch('/api/fit/hr', { method: 'POST', body: form });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  } catch (err) {
    showHrStatus('Could not read .fit: ' + err.message, 'error');
    return;
  }

  if (!data.count) {
    showHrStatus(data.error || 'No heart-rate data in that .fit file.', 'error');
    return;
  }

  const matched = mergeHrSamples(data.samples);
  if (matched === 0) {
    hrLoaded = false;
    showHrStatus(
      `No points matched. The .fit and GPX timestamps don't overlap — ` +
      `is this the same activity?`, 'error');
    hrClearBtn.hidden = true;
  } else {
    hrLoaded = true;
    const pct = Math.round(matched / allPoints.length * 100);
    showHrStatus(
      `Merged HR into ${matched.toLocaleString()} / ${allPoints.length.toLocaleString()} ` +
      `points (${pct}%) · ${data.hr_min}–${data.hr_max} bpm`, 'ok');
    hrClearBtn.hidden = false;
  }
  updateDisplay();
}

fitInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadFitFile(file);
});

hrClearBtn.addEventListener('click', () => {
  resetHr();
  updateDisplay();
});

// Inject <gpxtpx:hr> into a trkpt, creating the extension wrappers as needed.
// The extensions element must be in the GPX namespace — plain createElement()
// produces a null-namespace element that browsers serialize as
// xmlns="http://www.w3.org/1999/xhtml", and gpxpy ignores anything not in the
// GPX namespace, so HR silently never makes it into the server-side parse.
const GPX_NS = 'http://www.topografix.com/GPX/1/1';
function setTrkptHr(doc, trkpt, hr) {
  let ext = trkpt.getElementsByTagNameNS(GPX_NS, 'extensions')[0]
         || trkpt.getElementsByTagName('extensions')[0];
  if (!ext) { ext = doc.createElementNS(GPX_NS, 'extensions'); trkpt.appendChild(ext); }
  let tpe = ext.getElementsByTagNameNS(GPXTPX_NS, 'TrackPointExtension')[0]
         || ext.getElementsByTagName('gpxtpx:TrackPointExtension')[0];
  if (!tpe) { tpe = doc.createElementNS(GPXTPX_NS, 'gpxtpx:TrackPointExtension'); ext.appendChild(tpe); }
  let hrEl = tpe.getElementsByTagNameNS(GPXTPX_NS, 'hr')[0]
          || tpe.getElementsByTagName('gpxtpx:hr')[0];
  if (!hrEl) { hrEl = doc.createElementNS(GPXTPX_NS, 'gpxtpx:hr'); tpe.appendChild(hrEl); }
  hrEl.textContent = String(hr);
}

// ── Build edited GPX bytes (shared by Download + Save) ────────────────────────
function buildEditedGpx() {
  if (!currentDoc) return null;
  const doc = currentDoc.cloneNode(true);
  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  const total = trkpts.length;

  // Inject merged HR first — indices still align with allPoints here.
  if (hrLoaded) {
    doc.documentElement.setAttribute('xmlns:gpxtpx', GPXTPX_NS);
    for (let i = 0; i < total; i++) {
      const hr = allPoints[i] && allPoints[i].hr;
      if (hr != null && trkpts[i]) setTrkptHr(doc, trkpts[i], hr);
    }
  }

  const toRemove = new Set();
  for (let i = 0; i < trimStart; i++) toRemove.add(i);
  for (let i = total - trimEnd; i < total; i++) toRemove.add(i);
  removedSet.forEach(idx => toRemove.add(idx));
  [...toRemove].sort((a, b) => b - a).forEach(idx => {
    const pt = trkpts[idx];
    if (pt && pt.parentNode) pt.parentNode.removeChild(pt);
  });

  const xmlStr = new XMLSerializer().serializeToString(doc);
  const blob = new Blob([xmlStr], { type: 'application/gpx+xml' });
  const suffix = (toRemove.size > 0 ? '_trimmed' : '') + (hrLoaded ? '_hr' : '');
  const filename =
    currentFilename.replace(/\.gpx$/i, (suffix || '_edited') + '.gpx') || 'edited.gpx';
  return { blob, filename, keptCount: total - toRemove.size };
}

// ── Download (fully client-side) ──────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  const built = buildEditedGpx();
  if (!built) return;
  const url = URL.createObjectURL(built.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = built.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ── Save to "My Activities" ───────────────────────────────────────────────────
const saveBtn    = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

function setSaveStatus(text, kind) {
  saveStatus.className = 'save-status' + (kind ? ' ' + kind : '');
  saveStatus.innerHTML = text;
  saveStatus.hidden = !text;
}

saveBtn.addEventListener('click', async () => {
  const built = buildEditedGpx();
  if (!built) return;
  saveBtn.disabled = true;
  setSaveStatus('Saving&hellip;', '');
  try {
    const fd = new FormData();
    fd.append('gpx', built.blob, built.filename);
    const r = await fetch('/api/strava/activities/local', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) {
      setSaveStatus(`Save failed: ${j.error || r.status}`, 'error');
    } else {
      setSaveStatus(
        `Saved &mdash; <a href="${j.url}">view in My Activities</a>`,
        'ok',
      );
    }
  } catch (err) {
    setSaveStatus(`Save failed: ${err.message || err}`, 'error');
  } finally {
    saveBtn.disabled = false;
  }
});

// ── Event wiring ──────────────────────────────────────────────────────────────
fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  readFile(file);
});

startSlider.addEventListener('input',  e => setTrimStart(e.target.value));
startNum.addEventListener('input',     e => setTrimStart(e.target.value));
endSlider.addEventListener('input',    e => setTrimEnd(e.target.value));
endNum.addEventListener('input',       e => setTrimEnd(e.target.value));
cursorSlider.addEventListener('input', e => setCursor(e.target.value, { pan: true }));
cursorNum.addEventListener('input',    e => setCursor(e.target.value, { pan: true }));

markBtn.addEventListener('click', () => {
  if (!allPoints.length) return;
  removedSet.add(cursorIdx);
  updateDisplay();
  updateMap();
});

unmarkBtn.addEventListener('click', () => {
  if (!allPoints.length) return;
  removedSet.delete(cursorIdx);
  updateDisplay();
  updateMap();
});

clearBtn.addEventListener('click', () => {
  if (removedSet.size === 0) return;
  removedSet.clear();
  updateDisplay();
  updateMap();
});

document.addEventListener('click', e => {
  const btn = e.target.closest('.btn-step');
  if (!btn || !allPoints.length) return;
  const delta = parseInt(btn.dataset.delta, 10);
  const tgt = btn.dataset.target;
  if      (tgt === 'start')  setTrimStart(trimStart + delta);
  else if (tgt === 'end')    setTrimEnd(trimEnd + delta);
  else if (tgt === 'cursor') setCursor(cursorIdx + delta, { pan: true });
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
