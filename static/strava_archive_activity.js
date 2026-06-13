(() => {
  const $ = (id) => document.getElementById(id);
  const ID = window.__ACTIVITY_ID;
  const M_PER_MI = 1609.344;
  const M_PER_FT = 0.3048;

  const TYPE_ICONS = {
    "Ride":         "🚴",
    "Virtual Ride": "🎮",
    "E-Bike Ride":  "⚡🚴",
    "Run":          "🏃",
    "Swim":         "🏊",
    "Walk":         "🚶",
    "Hike":         "🥾",
    "Workout":      "🏋️",
    "Yoga":         "🧘",
    "Rowing":       "🚣",
    "Kayaking":     "🛶",
  };
  const PACE_TYPES = new Set(["Run", "Walk", "Hike"]);

  const state = {
    units: localStorage.getItem("ts.units") || "mi",
    seriesVisible: (() => {
      const defaults = { elev: true, hr: true, pwr: true, cad: true };
      try {
        const saved = JSON.parse(localStorage.getItem("ts.chart.series"));
        return saved && typeof saved === "object" ? { ...defaults, ...saved } : defaults;
      } catch { return defaults; }
    })(),
    data:  null,
    map:   null,
    track: null,
    startM: null,
    endM:   null,
    cursorM:    null,          // Leaflet marker for cursor on map
    cursorLine: null,          // SVG vertical line on elevation chart
    cursorDot:  null,          // SVG circle on elevation chart
    cursorIdx:  0,
    playing:    false,
    playTimer:  null,
    cumulativeDistM: [],       // per-point cumulative meters
    pointSpeedsMps: [],        // per-point smoothed speed (m/s)
    totalDistM: 0,
    elevPlot:   null,          // { PAD, W, H, innerW, innerH, minE, maxE, totalDist }
  };

  // ───────────────── Formatters ─────────────────

  const fmtDist = (m) => {
    if (m == null) return "—";
    return state.units === "mi"
      ? `${(m / M_PER_MI).toFixed(2)} mi`
      : `${(m / 1000).toFixed(2)} km`;
  };
  const fmtElev = (m) => {
    if (m == null) return "—";
    return state.units === "mi"
      ? `${Math.round(m / M_PER_FT).toLocaleString()} ft`
      : `${Math.round(m).toLocaleString()} m`;
  };
  const fmtSpeed = (mps) => {
    if (mps == null) return "—";
    return state.units === "mi"
      ? `${(mps * 3600 / M_PER_MI).toFixed(1)} mph`
      : `${(mps * 3.6).toFixed(1)} km/h`;
  };
  const fmtPace = (mps) => {
    if (mps == null || mps <= 0) return "—";
    const secPerUnit = state.units === "mi" ? M_PER_MI / mps : 1000 / mps;
    const m = Math.floor(secPerUnit / 60);
    const s = Math.round(secPerUnit % 60);
    return `${m}:${String(s).padStart(2, "0")} /${state.units}`;
  };
  const fmtTime = (s) => {
    if (s == null) return "—";
    s = Math.round(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };
  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric",
    }) + " · " + d.toLocaleTimeString(undefined, {
      hour: "numeric", minute: "2-digit",
    });
  };
  const fmtTempC = (c) => {
    if (c == null) return "—";
    if (state.units === "mi") return `${Math.round(c * 9 / 5 + 32)} °F`;
    return `${Math.round(c)} °C`;
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  // ───────────────── Geometry ─────────────────

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function computeCumulativeDist(points) {
    const cum = new Array(points.length).fill(0);
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1], p1 = points[i];
      if (p0.lat != null && p1.lat != null) {
        total += haversineM(p0.lat, p0.lon, p1.lat, p1.lon);
      }
      cum[i] = total;
    }
    return { cum, total };
  }

  // Per-point speed (m/s), smoothed by a trailing N-point window. Raw 1-second
  // GPS samples are too jittery to read; 5 points keeps the cursor display
  // stable without lagging too far behind real changes.
  function computeSpeeds(points, cumM) {
    const speeds = new Array(points.length).fill(null);
    const WINDOW = 5;
    for (let i = 1; i < points.length; i++) {
      const j = Math.max(0, i - WINDOW);
      const t_i = points[i].time, t_j = points[j].time;
      if (!t_i || !t_j) continue;
      const dDist = cumM[i] - cumM[j];
      const dTime = (new Date(t_i) - new Date(t_j)) / 1000;
      if (dTime > 0) speeds[i] = dDist / dTime;
    }
    speeds[0] = speeds[1] ?? 0;
    return speeds;
  }

  // ───────────────── Map ─────────────────

  function initMap(points) {
    if (state.map) return;
    state.map = L.map("map", { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(state.map);

    const latlngs = points
      .filter(p => p.lat != null && p.lon != null)
      .map(p => [p.lat, p.lon]);

    if (!latlngs.length) {
      $("map-section").hidden = true;
      return;
    }

    state.track = L.polyline(latlngs, {
      color: "#2196F3",
      weight: 4,
      opacity: 0.95,
    }).addTo(state.map);

    const startMarker = L.divIcon({
      className: "endpoint-marker start",
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    const endMarker = L.divIcon({
      className: "endpoint-marker end",
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    state.startM = L.marker(latlngs[0], { icon: startMarker, title: "Start" }).addTo(state.map);
    state.endM   = L.marker(latlngs[latlngs.length - 1], { icon: endMarker, title: "End" }).addTo(state.map);

    state.map.fitBounds(state.track.getBounds(), { padding: [20, 20] });
  }

  // ───────────────── Multi-series profile chart ─────────────────

  // Plot elevation, HR, and power on the same chart. Each series independently
  // y-normalized so shapes are comparable even with very different units.
  function renderElevation(points) {
    const W = 1000, H = 220, PAD = 10;
    const innerW = W - PAD * 2;
    const innerH = H - PAD * 2;
    const totalDist = state.totalDistM || 1;

    // Decide which series are available
    const hasElev  = points.some(p => p.elevation_m != null && p.lat != null);
    const hasHr    = points.some(p => p.hr != null && p.hr > 0);
    const hasPwr   = points.some(p => p.power != null && p.power > 0);
    const hasCad   = points.some(p => p.cadence != null && p.cadence > 0);

    if (!hasElev && !hasHr && !hasPwr && !hasCad) {
      $("elevation-section").hidden = true;
      state.elevPlot = null;
      return;
    }
    $("elevation-section").hidden = false;

    // Show only the toggles whose data exists
    $("series-elev-wrap").hidden = !hasElev;
    $("series-hr-wrap").hidden   = !hasHr;
    $("series-pwr-wrap").hidden  = !hasPwr;
    $("series-cad-wrap").hidden  = !hasCad;
    $("series-elev").checked = state.seriesVisible.elev;
    $("series-hr").checked   = state.seriesVisible.hr;
    $("series-pwr").checked  = state.seriesVisible.pwr;
    $("series-cad").checked  = state.seriesVisible.cad;

    // Decimate to ~600 points max for SVG perf — based on all points (so
    // x-positions stay consistent across series).
    const valid = points.filter(p => p.lat != null);
    const baseSample = valid.length >= 2 ? valid : points;
    const MAX = 600;
    const step = Math.max(1, Math.floor(baseSample.length / MAX));
    const sampled = [];
    for (let i = 0; i < baseSample.length; i += step) sampled.push(baseSample[i]);
    if (sampled[sampled.length - 1] !== baseSample[baseSample.length - 1]) {
      sampled.push(baseSample[baseSample.length - 1]);
    }

    // Build one polyline + (optional) area-fill for a given field
    function buildSeries(name, field, color, isPositive, withArea) {
      const ok = (v) => v != null && (!isPositive || v > 0);
      const seriesPts = sampled.filter(p => ok(p[field]));
      if (seriesPts.length < 2) return { svg: "", min: null, max: null };

      let min = Infinity, max = -Infinity;
      for (const p of seriesPts) {
        if (p[field] < min) min = p[field];
        if (p[field] > max) max = p[field];
      }
      if (min === max) max = min + 1;

      const coords = seriesPts.map(p => {
        const origIdx = points.indexOf(p);
        const d = origIdx >= 0 ? state.cumulativeDistM[origIdx] : 0;
        const x = PAD + (d / totalDist) * innerW;
        const y = PAD + innerH - ((p[field] - min) / (max - min)) * innerH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      let svg = "";
      if (withArea) {
        const x0 = coords[0].split(",")[0];
        const xN = coords[coords.length - 1].split(",")[0];
        const area = `${x0},${H - PAD} ${coords.join(" ")} ${xN},${H - PAD}`;
        svg += `<polyline class="series series-${name}" points="${area}" fill="${color}33" stroke="none"/>`;
      }
      svg += `<polyline class="series series-${name}" points="${coords.join(" ")}" fill="none" stroke="${color}" stroke-width="${withArea ? 2 : 1.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
      return { svg, min, max };
    }

    const elev = hasElev ? buildSeries("elev", "elevation_m", "#2196F3", false, true)  : { svg: "", min: 0, max: 1 };
    const hr   = hasHr   ? buildSeries("hr",   "hr",          "#e53935", true,  false) : { svg: "" };
    const pwr  = hasPwr  ? buildSeries("pwr",  "power",       "#FFB300", true,  false) : { svg: "" };
    const cad  = hasCad  ? buildSeries("cad",  "cadence",     "#4caf50", true,  false) : { svg: "" };

    const svg = $("elev-chart");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    // Order: elevation (with area) at bottom, then thin metric lines on top, cursor topmost
    svg.innerHTML = `
      ${elev.svg}
      ${pwr.svg}
      ${cad.svg}
      ${hr.svg}
      <line id="elev-cursor-line" y1="${PAD}" y2="${H - PAD}"
            stroke="#FFEB3B" stroke-width="1.5" stroke-dasharray="3,3"
            x1="${PAD}" x2="${PAD}" pointer-events="none" visibility="hidden"/>
      <circle id="elev-cursor-dot" r="5" fill="#FFEB3B" stroke="#000" stroke-width="1.5"
              cx="${PAD}" cy="${H - PAD}" pointer-events="none" visibility="hidden"/>
    `;
    state.cursorLine = svg.querySelector("#elev-cursor-line");
    state.cursorDot  = svg.querySelector("#elev-cursor-dot");

    // For cursor-dot positioning (still anchored to elevation curve when visible)
    state.elevPlot = {
      W, H, PAD, innerW, innerH,
      minE: elev.min ?? 0, maxE: elev.max ?? 1,
      totalDist, hasElev,
    };

    $("elev-x0").textContent = fmtDist(0);
    $("elev-x1").textContent = fmtDist(totalDist);

    applySeriesVisibility();

    // Click on the chart → jump cursor to nearest point by distance
    const chartWrap = svg.parentElement;
    chartWrap.onclick = (e) => {
      const rect = svg.getBoundingClientRect();
      const xFrac = (e.clientX - rect.left) / rect.width;
      const targetM = Math.max(0, Math.min(1, xFrac)) * state.totalDistM;
      const idx = nearestByDistance(targetM);
      setCursor(idx);
    };
  }

  function applySeriesVisibility() {
    for (const key of ["elev", "hr", "pwr", "cad"]) {
      const visible = !!state.seriesVisible[key];
      document.querySelectorAll(`#elev-chart .series-${key}`)
        .forEach(el => el.style.display = visible ? "" : "none");
    }
  }

  function setupSeriesToggles() {
    const wire = (id, key) => {
      const cb = $(id);
      if (!cb) return;
      cb.addEventListener("change", () => {
        state.seriesVisible[key] = cb.checked;
        try { localStorage.setItem("ts.chart.series", JSON.stringify(state.seriesVisible)); } catch {}
        applySeriesVisibility();
        if (key === "elev" && state.data) setCursor(state.cursorIdx);
      });
    };
    wire("series-elev", "elev");
    wire("series-hr",   "hr");
    wire("series-pwr",  "pwr");
    wire("series-cad",  "cad");
  }

  // ───────────────── Cursor logic ─────────────────

  function nearestByPosition(latlng) {
    const pts = state.data.points;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].lat == null) continue;
      const dLat = pts[i].lat - latlng.lat;
      const dLon = pts[i].lng - latlng.lng;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function nearestByDistance(targetM) {
    const cum = state.cumulativeDistM;
    if (!cum.length) return 0;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < targetM) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && targetM - cum[lo - 1] < cum[lo] - targetM) return lo - 1;
    return lo;
  }

  function setCursor(idx) {
    const pts = state.data.points;
    idx = Math.max(0, Math.min(idx, pts.length - 1));
    state.cursorIdx = idx;
    const p = pts[idx];

    // Scrubber + fill background
    const scrub = $("cursor-scrubber");
    scrub.value = idx;
    const pct = pts.length > 1 ? (idx / (pts.length - 1)) * 100 : 0;
    scrub.style.setProperty("--pct", `${pct}%`);

    // Map marker
    if (state.cursorM && p.lat != null) {
      state.cursorM.setLatLng([p.lat, p.lon]);
    }

    // Elevation cursor (vertical line + dot)
    if (state.cursorLine && state.elevPlot) {
      const { PAD, innerW, innerH, minE, maxE, totalDist, H } = state.elevPlot;
      const d = state.cumulativeDistM[idx] || 0;
      const x = PAD + (d / totalDist) * innerW;
      state.cursorLine.setAttribute("x1", x);
      state.cursorLine.setAttribute("x2", x);
      state.cursorLine.setAttribute("visibility", "visible");
      if (p.elevation_m != null && state.seriesVisible.elev) {
        const y = PAD + innerH - ((p.elevation_m - minE) / (maxE - minE)) * innerH;
        state.cursorDot.setAttribute("cx", x);
        state.cursorDot.setAttribute("cy", y);
        state.cursorDot.setAttribute("visibility", "visible");
      } else {
        state.cursorDot.setAttribute("visibility", "hidden");
      }
    }

    renderCursorStats(p, idx);
  }

  function elapsedSecAt(idx) {
    const pts = state.data.points;
    if (!pts[0]?.time || !pts[idx]?.time) return null;
    return Math.round((new Date(pts[idx].time) - new Date(pts[0].time)) / 1000);
  }

  function renderCursorStats(p, idx) {
    const dist = state.cumulativeDistM[idx] || 0;
    const elapsed = elapsedSecAt(idx);
    const speedMps = state.pointSpeedsMps[idx];
    const isPace = PACE_TYPES.has(state.data.activity.type);
    const cells = [
      ["Distance", fmtDist(dist)],
      ["Time",     elapsed != null ? fmtTime(elapsed) : "—"],
      ["Point",    `${(idx + 1).toLocaleString()} / ${state.data.points.length.toLocaleString()}`],
    ];
    if (speedMps != null && speedMps > 0) {
      cells.push([isPace ? "Pace" : "Speed",
                  isPace ? fmtPace(speedMps) : fmtSpeed(speedMps)]);
    }
    if (p.elevation_m != null) cells.push(["Elev",     fmtElev(p.elevation_m)]);
    if (p.hr != null)          cells.push(["HR",       `${p.hr} bpm`]);
    if (p.power != null)       cells.push(["Power",    `${p.power} W`]);
    if (p.cadence != null)     cells.push(["Cadence",  `${p.cadence}`]);
    if (p.temperature_c != null) cells.push(["Temp",   fmtTempC(p.temperature_c)]);

    $("cursor-stats").innerHTML = cells
      .map(([k, v]) => `<span class="cursor-stat"><span class="stat-label">${k}</span><span class="stat-val">${v}</span></span>`)
      .join("");
  }

  function initCursor(points) {
    if (points.length === 0) return;
    $("cursor-section").hidden = false;

    const scrub = $("cursor-scrubber");
    scrub.max = points.length - 1;
    scrub.value = 0;
    scrub.addEventListener("input", () => {
      stopPlayback();
      setCursor(Number(scrub.value));
    });

    $("cursor-play").addEventListener("click", togglePlayback);

    // Map cursor marker (after map is up)
    if (state.map) {
      const first = points.find(p => p.lat != null);
      if (first) {
        const icon = L.divIcon({
          className: "cursor-marker",
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        state.cursorM = L.marker([first.lat, first.lon], {
          icon, interactive: false, keyboard: false, zIndexOffset: 1000,
        }).addTo(state.map);
      }
      state.map.on("click", (e) => {
        setCursor(nearestByPosition(e.latlng));
      });
    }

    setCursor(0);
  }

  function togglePlayback() {
    if (state.playing) stopPlayback();
    else startPlayback();
  }

  function startPlayback() {
    const pts = state.data.points;
    if (state.cursorIdx >= pts.length - 1) state.cursorIdx = 0;
    state.playing = true;
    $("cursor-play").classList.add("playing");
    $("cursor-play").textContent = "❚❚";
    // Play through the full activity in ~30 seconds regardless of point count
    const stepMs = Math.max(20, (30 * 1000) / pts.length);
    state.playTimer = setInterval(() => {
      const next = state.cursorIdx + 1;
      if (next >= pts.length) { stopPlayback(); return; }
      setCursor(next);
    }, stepMs);
  }

  function stopPlayback() {
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
    state.playing = false;
    $("cursor-play").classList.remove("playing");
    $("cursor-play").textContent = "▶";
  }

  // ───────────────── Stat grid ─────────────────

  function buildStat(label, value, sub) {
    return `
      <div class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
        ${sub ? `<div class="stat-sub">${sub}</div>` : ""}
      </div>
    `;
  }

  function renderStats(a) {
    const stats = [];

    stats.push(buildStat("Distance", fmtDist(a.distance_m)));
    stats.push(buildStat("Moving time", fmtTime(a.moving_time_s),
      a.elapsed_time_s && a.elapsed_time_s !== a.moving_time_s
        ? `elapsed ${fmtTime(a.elapsed_time_s)}` : ""));

    if (a.elevation_gain_m != null) {
      stats.push(buildStat("Elev gain", fmtElev(a.elevation_gain_m),
        a.elevation_high_m != null
          ? `peak ${fmtElev(a.elevation_high_m)}` : ""));
    }

    // Pace for human-powered, speed for vehicles
    if (PACE_TYPES.has(a.type)) {
      stats.push(buildStat("Avg pace", fmtPace(a.avg_speed_mps),
        a.max_speed_mps != null ? `max ${fmtSpeed(a.max_speed_mps)}` : ""));
    } else if (a.avg_speed_mps != null) {
      stats.push(buildStat("Avg speed", fmtSpeed(a.avg_speed_mps),
        a.max_speed_mps != null ? `max ${fmtSpeed(a.max_speed_mps)}` : ""));
    }

    if (a.avg_hr != null) {
      stats.push(buildStat("Avg HR", `${Math.round(a.avg_hr)} bpm`,
        a.max_hr != null ? `max ${Math.round(a.max_hr)}` : ""));
    }
    if (a.avg_watts != null) {
      stats.push(buildStat("Avg power", `${Math.round(a.avg_watts)} W`,
        a.max_watts != null ? `max ${Math.round(a.max_watts)}` : ""));
    }
    if (a.avg_cadence != null) {
      stats.push(buildStat("Avg cadence", `${Math.round(a.avg_cadence)}`,
        a.max_cadence != null ? `max ${Math.round(a.max_cadence)}` : ""));
    }
    if (a.calories != null) {
      stats.push(buildStat("Calories", `${Math.round(a.calories).toLocaleString()}`));
    }
    if (a.avg_temp_c != null) {
      stats.push(buildStat("Avg temp", fmtTempC(a.avg_temp_c)));
    }

    $("stat-grid").innerHTML = stats.join("");
  }

  function renderHeader(a) {
    $("type-icon").textContent = TYPE_ICONS[a.type] || "📍";
    $("activity-name").textContent = a.name || "(unnamed)";
    $("activity-date").textContent = fmtDate(a.start_time);
    $("activity-type").textContent = a.type || "";
    $("activity-gear").textContent = a.gear || "";
    $("meta-sep-1").hidden = !a.type;
    $("meta-sep-2").hidden = !a.gear;

    if (a.location) {
      const el = $("activity-location");
      el.textContent = a.location;
      el.hidden = false;
    }

    if (a.description && a.description.trim()) {
      const el = $("activity-description");
      el.textContent = a.description;
      el.hidden = false;
    }

    if (a.raw_csv) {
      $("raw-csv").textContent = JSON.stringify(a.raw_csv, null, 2);
    }

    if (a.has_points) {
      const dl = $("download-gpx");
      dl.href   = `/api/strava/activities/${a.id}/gpx`;
      dl.hidden = false;
    }

    if (a.source === "local") {
      $("meta-edit-btn").hidden = false;
    }

    renderReplacementBanner(a);

    document.title = `${a.name || "Activity"} · Track Studio`;
  }

  // ───────────────── Meta edit (local activities only) ─────────────────

  function openMetaEdit() {
    const a = state.data && state.data.activity;
    if (!a) return;
    $("meta-name").value        = a.name || "";
    $("meta-gear").value        = a.gear || "";
    $("meta-description").value = a.description || "";
    const sel = $("meta-type");
    const opts = Array.from(sel.options).map(o => o.value);
    if (a.type && !opts.includes(a.type)) {
      const o = document.createElement("option");
      o.value = a.type; o.textContent = a.type;
      sel.appendChild(o);
    }
    sel.value = a.type || "Workout";
    setMetaStatus("");
    $("meta-edit-form").hidden = false;
    $("meta-edit-btn").hidden  = true;
    $("meta-name").focus();
  }

  function closeMetaEdit() {
    $("meta-edit-form").hidden = true;
    $("meta-edit-btn").hidden  = false;
    setMetaStatus("");
  }

  function setMetaStatus(text, kind) {
    const el = $("meta-status");
    el.className = "meta-status" + (kind ? " " + kind : "");
    el.textContent = text;
    el.hidden = !text;
  }

  async function submitMetaEdit(ev) {
    ev.preventDefault();
    const a = state.data && state.data.activity;
    if (!a) return;
    const body = {
      name:        $("meta-name").value.trim(),
      type:        $("meta-type").value,
      gear:        $("meta-gear").value.trim() || null,
      description: $("meta-description").value.trim() || null,
    };
    setMetaStatus("Saving…");
    try {
      const r = await fetch(`/api/strava/activities/${a.id}/meta`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) { setMetaStatus(j.error || `Failed (${r.status})`, "error"); return; }
      Object.assign(a, body);
      renderHeader(a);
      closeMetaEdit();
    } catch (err) {
      setMetaStatus(`Failed: ${err.message || err}`, "error");
    }
  }

  $("meta-edit-btn")?.addEventListener("click",  openMetaEdit);
  $("meta-cancel-btn")?.addEventListener("click", closeMetaEdit);
  $("meta-edit-form")?.addEventListener("submit", submitMetaEdit);

  function renderReplacementBanner(a) {
    const el = $("replacement-banner");
    const when = a.replaced_at ? new Date(a.replaced_at).toLocaleDateString() : null;
    if (a.replaced_local_id != null) {
      // This is a Strava row that replaced an earlier local upload.
      const link = `<a href="/strava_archive/activity/${a.replaced_local_id}">view your original upload</a>`;
      el.className = "replacement-banner";
      el.innerHTML = `This activity replaced a local upload${when ? ` on ${when}` : ""}. The original file is still on disk — ${link}.`;
      el.hidden = false;
    } else if (a.replaced_by_id != null) {
      // This is a local row that was superseded by a later Strava ingest.
      const link = `<a href="/strava_archive/activity/${a.replaced_by_id}">go to the Strava version</a>`;
      el.className = "replacement-banner superseded";
      el.innerHTML = `Superseded by a Strava archive activity${when ? ` on ${when}` : ""} — ${link}. This local copy is kept for safety.`;
      el.hidden = false;
    }
  }

  // ───────────────── Unit toggle ─────────────────

  function setupUnitToggle() {
    document.querySelectorAll(".unit-toggle button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.unit === state.units);
      btn.addEventListener("click", () => {
        if (btn.dataset.unit === state.units) return;
        state.units = btn.dataset.unit;
        localStorage.setItem("ts.units", state.units);
        document.querySelectorAll(".unit-toggle button")
          .forEach((b) => b.classList.toggle("active", b.dataset.unit === state.units));
        if (state.data) {
          renderStats(state.data.activity);
          renderElevation(state.data.points);
          if (state.data.points.length > 0) {
            // renderElevation rebuilt the SVG, so re-paint cursor at current idx
            setCursor(state.cursorIdx);
          }
        }
      });
    });
  }

  // ───────────────── Init ─────────────────

  async function init() {
    setupUnitToggle();
    setupSeriesToggles();
    try {
      const resp = await fetch(`/api/strava/activities/${ID}`);
      if (resp.status === 404) {
        $("loading").hidden = true;
        $("not-found").hidden = false;
        return;
      }
      const data = await resp.json();
      state.data = data;

      $("loading").hidden = true;
      $("activity-card").hidden = false;

      renderHeader(data.activity);
      renderStats(data.activity);

      const points = data.points || [];
      if (points.length === 0) {
        $("map-section").hidden = true;
        $("no-track").hidden = false;
      } else {
        const { cum, total } = computeCumulativeDist(points);
        state.cumulativeDistM = cum;
        state.totalDistM = total || data.activity.distance_m || 1;
        state.pointSpeedsMps = computeSpeeds(points, cum);
        // Defer map init until tab is painted, otherwise tiles draw at 0×0
        setTimeout(() => {
          initMap(points);
          renderElevation(points);
          initCursor(points);
        }, 0);
      }
    } catch (e) {
      console.error(e);
      $("loading").textContent = "Failed to load activity.";
    }
  }

  init();
})();
