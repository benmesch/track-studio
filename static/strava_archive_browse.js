(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 50;
  const M_PER_MI = 1609.344;
  const M_PER_FT = 0.3048;
  const STORAGE_KEY = "ts.browse.filters";

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

  const state = {
    facets:       null,
    units:        localStorage.getItem("ts.units") || "mi",
    selectedType: "All",
    selectedGears: new Set(),
    selectedLocations: new Set(),
    hasHr:        false,
    hasElev:      false,
    q:            "",
    sort:         "date_desc",
    distance:     { lo: 0, hi: 1 },   // in m (will be set from facets)
    time:         { lo: 0, hi: 1 },   // in s
    elevation:    { lo: 0, hi: 1 },   // in m
    hour:         { lo: 0, hi: 23 },
    startDate:    "",
    endDate:      "",
    offset:       0,
    total:        0,
  };

  // ───────────────── Formatters ─────────────────

  const fmtDistance = (m) => {
    if (m == null) return "—";
    if (state.units === "mi") return `${(m / M_PER_MI).toFixed(1)} mi`;
    return `${(m / 1000).toFixed(1)} km`;
  };
  const fmtElevation = (m) => {
    if (m == null) return "—";
    if (state.units === "mi") return `${Math.round(m / M_PER_FT).toLocaleString()} ft`;
    return `${Math.round(m).toLocaleString()} m`;
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
  const fmtTimeShort = (s) => {
    s = Math.round(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };
  const fmtHour = (h) => {
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h % 12 || 12;
    return `${h12} ${ampm}`;
  };
  const fmtDistanceUnit = (m) =>
    state.units === "mi" ? (m / M_PER_MI).toFixed(m < M_PER_MI ? 2 : 1)
                          : (m / 1000).toFixed(m < 1000 ? 2 : 1);

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  // ───────────────── Dual-thumb range slider ─────────────────

  function setupRange(key, ids, opts) {
    const minInput = $(ids.min);
    const maxInput = $(ids.max);
    const fill     = $(ids.fill);
    const valEl    = $(ids.val);
    const { domainMin, domainMax, step = 1, formatRange, onChange } = opts;

    const span = domainMax - domainMin || 1;

    // Map slider native value (which we set as 0..span/step) → domain value
    const sliderMax = Math.max(1, Math.round(span / step));
    minInput.min = maxInput.min = 0;
    minInput.max = maxInput.max = sliderMax;
    minInput.value = 0;
    maxInput.value = sliderMax;

    const toDomain = (v) => domainMin + Number(v) * step;
    const toSlider = (d) => Math.round((d - domainMin) / step);

    function update(triggeredBy) {
      let lo = Number(minInput.value);
      let hi = Number(maxInput.value);
      if (lo > hi) {
        if (triggeredBy === "min") { lo = hi; minInput.value = lo; }
        else                        { hi = lo; maxInput.value = hi; }
      }
      const leftPct  = (lo / sliderMax) * 100;
      const rightPct = (hi / sliderMax) * 100;
      fill.style.left  = `${leftPct}%`;
      fill.style.right = `${100 - rightPct}%`;
      fill.style.width = "auto";
      const dLo = toDomain(lo);
      const dHi = toDomain(hi);
      if (valEl) valEl.textContent = formatRange(dLo, dHi);
      if (onChange) onChange(dLo, dHi);
    }

    minInput.addEventListener("input", () => update("min"));
    maxInput.addEventListener("input", () => update("max"));

    return {
      update,
      reset() {
        minInput.value = 0;
        maxInput.value = sliderMax;
        update();
      },
      setDomain(lo, hi) {
        if (lo != null) minInput.value = toSlider(lo);
        if (hi != null) maxInput.value = toSlider(hi);
        update();
      },
      isAtDefault() {
        return Number(minInput.value) === 0 && Number(maxInput.value) === sliderMax;
      },
    };
  }

  // ───────────────── Filter wiring ─────────────────

  let sliders = {};
  let queryTimer = null;
  const scheduleQuery = () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => { state.offset = 0; runQuery(true); }, 250);
  };

  function buildSliders() {
    const f = state.facets;
    // Distance — slider step is 0.1 mi or 0.1 km in domain units (meters)
    const distStep = state.units === "mi" ? M_PER_MI * 0.1 : 100;
    sliders.distance = setupRange("distance",
      { min: "distance-min", max: "distance-max", fill: "distance-fill", val: "distance-val" },
      {
        domainMin: 0,
        domainMax: f.distance_m.max,
        step: distStep,
        formatRange: (lo, hi) => `${fmtDistanceUnit(lo)} – ${fmtDistanceUnit(hi)} ${state.units}`,
        onChange: (lo, hi) => {
          state.distance = { lo, hi };
          updateFilterBadge();
          scheduleQuery();
        },
      });

    // Moving time — step 60s (1 min)
    sliders.time = setupRange("time",
      { min: "time-min", max: "time-max", fill: "time-fill", val: "time-val" },
      {
        domainMin: 0,
        domainMax: f.moving_time_s.max,
        step: 60,
        formatRange: (lo, hi) => `${fmtTimeShort(lo)} – ${fmtTimeShort(hi)}`,
        onChange: (lo, hi) => {
          state.time = { lo, hi };
          updateFilterBadge();
          scheduleQuery();
        },
      });

    // Elevation gain — step ~10 ft or 5 m
    const elevStep = state.units === "mi" ? M_PER_FT * 10 : 5;
    sliders.elevation = setupRange("elevation",
      { min: "elevation-min", max: "elevation-max", fill: "elevation-fill", val: "elevation-val" },
      {
        domainMin: 0,
        domainMax: f.elevation_m.max || 1,
        step: elevStep,
        formatRange: (lo, hi) => `${fmtElevation(lo)} – ${fmtElevation(hi)}`,
        onChange: (lo, hi) => {
          state.elevation = { lo, hi };
          updateFilterBadge();
          scheduleQuery();
        },
      });

    // Time of day 0–23
    sliders.hour = setupRange("hour",
      { min: "hour-min", max: "hour-max", fill: "hour-fill", val: "hour-val" },
      {
        domainMin: 0,
        domainMax: 23,
        step: 1,
        formatRange: (lo, hi) => `${fmtHour(lo)} – ${fmtHour(hi + 1 > 23 ? 23 : hi)}`,
        onChange: (lo, hi) => {
          state.hour = { lo, hi };
          updateFilterBadge();
          scheduleQuery();
        },
      });
  }

  function rebuildSlidersForUnits() {
    // Re-create sliders so step granularity matches the new unit system
    buildSliders();
  }

  function buildTypeTabs() {
    const nav = $("type-tabs");
    nav.innerHTML = "";
    const f = state.facets;
    const tabs = [
      { type: "All", count: f.total },
      ...f.types,
    ];
    for (const t of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "type-tab" + (t.type === state.selectedType ? " active" : "");
      btn.dataset.type = t.type;
      const icon = TYPE_ICONS[t.type] || "";
      btn.innerHTML = `${icon ? `<span class="type-icon">${icon}</span>` : ""}<span>${esc(t.type)}</span><span class="tab-count">${t.count.toLocaleString()}</span>`;
      btn.addEventListener("click", () => {
        state.selectedType = t.type;
        document.querySelectorAll(".type-tab").forEach((el) => el.classList.toggle("active", el.dataset.type === t.type));
        updateFilterBadge();
        state.offset = 0;
        runQuery(true);
      });
      nav.appendChild(btn);
    }
  }

  function setupExtraBlockToggles() {
    document.querySelectorAll(".extra-block-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.dataset.target);
        if (!target) return;
        const opening = target.hidden;
        target.hidden = !opening;
        btn.setAttribute("aria-expanded", String(opening));
      });
    });
  }

  function setExtraBlockExpanded(toggleBtnId, targetId, expanded) {
    const btn = document.querySelector(`.extra-block-toggle[data-target="${targetId}"]`);
    const body = document.getElementById(targetId);
    if (!btn || !body) return;
    body.hidden = !expanded;
    btn.setAttribute("aria-expanded", String(expanded));
  }

  function updateLocationSelectedBadge() {
    const n = state.selectedLocations.size;
    const el = $("location-selected-count");
    el.textContent = n;
    el.hidden = n === 0;
  }

  function updateGearSelectedBadge() {
    const n = state.selectedGears.size;
    const el = $("gear-selected-count");
    el.textContent = n;
    el.hidden = n === 0;
  }

  function buildLocationPills() {
    const block = $("location-block");
    const wrap  = $("location-pills");
    const locs  = state.facets.locations || [];
    if (!locs.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    wrap.innerHTML = "";
    for (const l of locs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gear-pill";
      btn.dataset.location = l.location;
      btn.innerHTML = `<span>${esc(l.location)}</span><span class="pill-count">${l.count.toLocaleString()}</span>`;
      btn.addEventListener("click", () => {
        if (state.selectedLocations.has(l.location)) state.selectedLocations.delete(l.location);
        else state.selectedLocations.add(l.location);
        btn.classList.toggle("active");
        updateLocationSelectedBadge();
        updateFilterBadge();
        state.offset = 0;
        runQuery(true);
      });
      wrap.appendChild(btn);
    }
  }

  function buildGearPills() {
    const block = $("gear-block");
    const wrap  = $("gear-pills");
    const gears = state.facets.gears || [];
    if (!gears.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    wrap.innerHTML = "";
    for (const g of gears) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gear-pill";
      btn.dataset.gear = g.gear;
      btn.innerHTML = `<span>${esc(g.gear)}</span><span class="pill-count">${g.count.toLocaleString()}</span>`;
      btn.addEventListener("click", () => {
        if (state.selectedGears.has(g.gear)) state.selectedGears.delete(g.gear);
        else state.selectedGears.add(g.gear);
        btn.classList.toggle("active");
        updateGearSelectedBadge();
        updateFilterBadge();
        state.offset = 0;
        runQuery(true);
      });
      wrap.appendChild(btn);
    }
  }

  function setupHasHr() {
    const cb = $("has-hr-input");
    const cnt = $("has-hr-count");
    if (state.facets.has_hr_count != null) {
      cnt.textContent = state.facets.has_hr_count.toLocaleString();
    }
    cb.addEventListener("change", () => {
      state.hasHr = cb.checked;
      updateFilterBadge();
      state.offset = 0;
      runQuery(true);
    });
  }

  function setupHasElev() {
    const cb = $("has-elev-input");
    const cnt = $("has-elev-count");
    if (state.facets.has_elev_count != null) {
      cnt.textContent = state.facets.has_elev_count.toLocaleString();
    }
    cb.addEventListener("change", () => {
      state.hasElev = cb.checked;
      updateFilterBadge();
      state.offset = 0;
      runQuery(true);
    });
  }

  function setupDateInputs() {
    const f = state.facets;
    if (f.date.min) {
      $("start-date").min = f.date.min;
      $("end-date").min   = f.date.min;
    }
    if (f.date.max) {
      $("start-date").max = f.date.max;
      $("end-date").max   = f.date.max;
    }
    $("start-date").addEventListener("change", () => { state.startDate = $("start-date").value; updateFilterBadge(); scheduleQuery(); });
    $("end-date").addEventListener("change",   () => { state.endDate   = $("end-date").value;   updateFilterBadge(); scheduleQuery(); });
  }

  function setupUnitToggle() {
    document.querySelectorAll(".unit-toggle button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.unit === state.units);
      btn.addEventListener("click", () => {
        if (btn.dataset.unit === state.units) return;
        state.units = btn.dataset.unit;
        localStorage.setItem("ts.units", state.units);
        document.querySelectorAll(".unit-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.unit === state.units));
        rebuildSlidersForUnits();
        renderList(currentResults, /*append*/ false);
      });
    });
  }

  function setupSearchAndSort() {
    $("q").addEventListener("input", () => {
      state.q = $("q").value;
      updateFilterBadge();
      scheduleQuery();
    });
    $("sort").addEventListener("change", () => {
      state.sort = $("sort").value;
      saveFilters();
      state.offset = 0;
      runQuery(true);
    });
    $("clear-filters").addEventListener("click", () => {
      $("q").value = ""; state.q = "";
      $("start-date").value = ""; $("end-date").value = "";
      state.startDate = ""; state.endDate = "";
      state.selectedType = "All";
      document.querySelectorAll(".type-tab").forEach((el) => el.classList.toggle("active", el.dataset.type === "All"));
      state.selectedGears.clear();
      state.selectedLocations.clear();
      document.querySelectorAll(".gear-pill").forEach((el) => el.classList.remove("active"));
      updateLocationSelectedBadge();
      updateGearSelectedBadge();
      setExtraBlockExpanded("location-block", "location-pills", false);
      setExtraBlockExpanded("gear-block", "gear-pills", false);
      state.hasHr = false;
      const hrCb = $("has-hr-input"); if (hrCb) hrCb.checked = false;
      state.hasElev = false;
      const elevCb = $("has-elev-input"); if (elevCb) elevCb.checked = false;
      Object.values(sliders).forEach((s) => s.reset());
      clearStoredFilters();
      updateFilterBadge();
      state.offset = 0;
      runQuery(true);
    });
  }

  function setupFilterToggle() {
    const btn = $("toggle-filters");
    const panel = $("filter-panel");
    btn.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
    setupExtraBlockToggles();
  }

  function countActiveFilters() {
    let n = 0;
    if (state.selectedType !== "All") n++;
    if (state.selectedGears.size > 0) n++;
    if (state.selectedLocations.size > 0) n++;
    if (state.hasHr) n++;
    if (state.hasElev) n++;
    if (state.q) n++;
    if (state.startDate || state.endDate) n++;
    if (sliders.distance  && !sliders.distance.isAtDefault())  n++;
    if (sliders.time      && !sliders.time.isAtDefault())      n++;
    if (sliders.elevation && !sliders.elevation.isAtDefault()) n++;
    if (sliders.hour      && !sliders.hour.isAtDefault())      n++;
    return n;
  }

  // ───────────────── Persistence (sessionStorage) ─────────────────
  // Keeps filter state alive across activity-detail navigation, wipes
  // on tab close or Clear filters.

  function saveFilters() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        selectedType:  state.selectedType,
        selectedGears: Array.from(state.selectedGears),
        selectedLocations: Array.from(state.selectedLocations),
        hasHr:         state.hasHr,
        hasElev:       state.hasElev,
        q:             state.q,
        sort:          state.sort,
        distance:      state.distance,
        time:          state.time,
        elevation:     state.elevation,
        hour:          state.hour,
        startDate:     state.startDate,
        endDate:       state.endDate,
      }));
    } catch {}
  }

  function loadFilters() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function clearStoredFilters() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
  }

  function restoreFilters(saved) {
    if (!saved) return;
    const f = state.facets;

    // Activity type tab
    if (saved.selectedType && f.types.some(t => t.type === saved.selectedType) || saved.selectedType === "All") {
      state.selectedType = saved.selectedType;
      document.querySelectorAll(".type-tab").forEach(el =>
        el.classList.toggle("active", el.dataset.type === state.selectedType));
    }

    // Gear pills
    const validGears = new Set((f.gears || []).map(g => g.gear));
    state.selectedGears = new Set((saved.selectedGears || []).filter(g => validGears.has(g)));
    document.querySelectorAll("#gear-pills .gear-pill").forEach(el =>
      el.classList.toggle("active", state.selectedGears.has(el.dataset.gear)));

    // Location pills
    const validLocs = new Set((f.locations || []).map(l => l.location));
    state.selectedLocations = new Set((saved.selectedLocations || []).filter(l => validLocs.has(l)));
    document.querySelectorAll("#location-pills .gear-pill").forEach(el =>
      el.classList.toggle("active", state.selectedLocations.has(el.dataset.location)));
    updateLocationSelectedBadge();
    updateGearSelectedBadge();
    // Sub-section starts collapsed unless that section has selections
    if (state.selectedLocations.size > 0) {
      setExtraBlockExpanded("location-block", "location-pills", true);
    }
    if (state.selectedGears.size > 0) {
      setExtraBlockExpanded("gear-block", "gear-pills", true);
    }

    // Has HR
    if (typeof saved.hasHr === "boolean") {
      state.hasHr = saved.hasHr;
      const cb = $("has-hr-input"); if (cb) cb.checked = saved.hasHr;
    }

    // Has elevation
    if (typeof saved.hasElev === "boolean") {
      state.hasElev = saved.hasElev;
      const cb = $("has-elev-input"); if (cb) cb.checked = saved.hasElev;
    }

    // Search + sort
    if (typeof saved.q === "string") {
      state.q = saved.q;
      $("q").value = saved.q;
    }
    if (saved.sort) {
      state.sort = saved.sort;
      $("sort").value = saved.sort;
    }

    // Sliders — clamp restored range to current facet bounds in case
    // a re-ingest changed the data extents.
    const setSlider = (key, max) => {
      const r = saved[key];
      if (!r || sliders[key] == null) return;
      const lo = Math.max(0,   Math.min(r.lo, max));
      const hi = Math.max(lo,  Math.min(r.hi, max));
      sliders[key].setDomain(lo, hi);
      state[key] = { lo, hi };
    };
    setSlider("distance",  f.distance_m.max);
    setSlider("time",      f.moving_time_s.max);
    setSlider("elevation", f.elevation_m.max || 1);
    if (saved.hour && sliders.hour) {
      const lo = Math.max(0, Math.min(saved.hour.lo, 23));
      const hi = Math.max(lo, Math.min(saved.hour.hi, 23));
      sliders.hour.setDomain(lo, hi);
      state.hour = { lo, hi };
    }

    // Date range
    if (saved.startDate) { state.startDate = saved.startDate; $("start-date").value = saved.startDate; }
    if (saved.endDate)   { state.endDate   = saved.endDate;   $("end-date").value   = saved.endDate; }

    // Filter panel stays collapsed on load even with active filters — the badge
    // count on the toggle is the signal that filters are applied. Saves the
    // user from scrolling past the long panel every time they navigate back.
  }

  function updateFilterBadge() {
    const n = countActiveFilters();
    const badge = $("filter-badge");
    badge.hidden = n === 0;
    badge.textContent = n;
    saveFilters();
  }

  // ───────────────── Querying ─────────────────

  function buildQueryParams() {
    const f = state.facets;
    const p = new URLSearchParams();
    if (state.selectedType !== "All") p.append("type", state.selectedType);
    for (const gear of state.selectedGears) p.append("gear", gear);
    for (const loc  of state.selectedLocations) p.append("location", loc);
    if (state.hasHr)   p.set("has_hr", "1");
    if (state.hasElev) p.set("has_elev", "1");
    if (state.q) p.set("q", state.q);
    p.set("sort", state.sort);
    p.set("limit", PAGE_SIZE);
    p.set("offset", state.offset);

    if (!sliders.distance?.isAtDefault()) {
      p.set("min_distance_m", state.distance.lo);
      p.set("max_distance_m", state.distance.hi);
    }
    if (!sliders.time?.isAtDefault()) {
      p.set("min_time_s", Math.round(state.time.lo));
      p.set("max_time_s", Math.round(state.time.hi));
    }
    if (!sliders.elevation?.isAtDefault()) {
      p.set("min_elevation_m", state.elevation.lo);
      p.set("max_elevation_m", state.elevation.hi);
    }
    if (!sliders.hour?.isAtDefault()) {
      p.set("hour_min", state.hour.lo);
      p.set("hour_max", state.hour.hi);
    }
    if (state.startDate) p.set("start_date", state.startDate);
    if (state.endDate)   p.set("end_date",   state.endDate);
    return p;
  }

  let currentResults = [];
  let currentReq = 0;

  async function runQuery(replace) {
    const reqId = ++currentReq;
    const p = buildQueryParams();
    try {
      const resp = await fetch(`/api/strava/activities?${p}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (reqId !== currentReq) return; // stale
      state.total = data.total;
      if (replace) {
        currentResults = data.results;
      } else {
        currentResults = currentResults.concat(data.results);
      }
      renderList(currentResults, !replace);
      updateSummary();
      updateLoadMore();
    } catch (e) {
      console.error(e);
    }
  }

  function updateSummary() {
    const n = state.total;
    const suffix = countActiveFilters() > 0 ? " matching filters" : "";
    $("result-summary").textContent = `${n.toLocaleString()} activit${n === 1 ? "y" : "ies"}${suffix}`;
  }

  function updateLoadMore() {
    const btn = $("load-more");
    const empty = $("results-empty");
    if (currentResults.length === 0) {
      btn.hidden = true;
      empty.hidden = false;
    } else if (currentResults.length < state.total) {
      btn.hidden = false;
      empty.hidden = true;
      btn.textContent = `Load more (${(state.total - currentResults.length).toLocaleString()} remaining)`;
    } else {
      btn.hidden = true;
      empty.hidden = true;
    }
  }

  function renderList(items, append) {
    const ul = $("results-list");
    const html = items.map((a) => {
      const icon = TYPE_ICONS[a.type] || "";
      const dist = a.distance_m != null
        ? `<span class="metric dist">${fmtDistance(a.distance_m)}</span>`
        : `<span class="metric dist no-data">—</span>`;
      const time = a.moving_time_s != null
        ? `<span class="metric time">${fmtTime(a.moving_time_s)}</span>`
        : `<span class="metric time no-data">—</span>`;
      const elev = a.elevation_gain_m != null
        ? `<span class="metric elev">${fmtElevation(a.elevation_gain_m)}</span>`
        : `<span class="metric elev no-data">—</span>`;
      const locLine = a.location
        ? `<span class="result-location">${esc(a.location)}</span>`
        : "";
      return `<li class="result-row">
        <a class="result-row-link" href="/strava_archive/activity/${a.id}">
          <span class="result-date-cell">
            <span class="result-date">${fmtDate(a.start_time)}</span>
            ${locLine}
          </span>
          <span class="result-name">
            <span class="type-icon" title="${esc(a.type || "")}">${icon}</span>
            <span class="name-text">${esc(a.name || "(unnamed)")}</span>
          </span>
          ${dist}${time}${elev}
        </a>
      </li>`;
    }).join("");
    ul.innerHTML = html;
  }

  $("load-more").addEventListener("click", () => {
    state.offset = currentResults.length;
    runQuery(false);
  });

  // ───────────────── Init ─────────────────

  async function init() {
    setupUnitToggle();
    setupSearchAndSort();
    setupFilterToggle();
    try {
      const resp = await fetch("/api/strava/activities/facets");
      state.facets = await resp.json();
    } catch {
      $("result-summary").textContent = "Failed to load.";
      return;
    }
    if (state.facets.total === 0) {
      $("result-summary").textContent = "";
      $("empty-state").hidden = false;
      document.querySelector(".filters").hidden = true;
      document.querySelector(".results").hidden = true;
      return;
    }
    buildTypeTabs();
    buildSliders();
    buildLocationPills();
    buildGearPills();
    setupHasHr();
    setupHasElev();
    setupDateInputs();
    restoreFilters(loadFilters());
    updateFilterBadge();
    runQuery(true);
  }

  init();
})();
