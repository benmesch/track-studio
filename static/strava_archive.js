(() => {
  const $ = (id) => document.getElementById(id);
  const fileInput  = $("archive-input");
  const uploadBtn  = $("upload-btn");
  const statusCard = $("status-card");
  const statusTitle = $("status-title");
  const uploadBar  = $("upload-bar");
  const uploadPct  = $("upload-pct");
  const csvBar     = $("csv-bar");
  const csvCount   = $("csv-count");
  const tracksBar  = $("tracks-bar");
  const tracksCount = $("tracks-count");
  const pointsLine = $("points-line");
  const errorsDetails = $("errors-details");
  const errorsSummary = $("errors-summary");
  const errorsList = $("errors-list");
  const dbCard     = $("db-card");
  const dbActivities = $("db-activities");
  const dbWithPoints = $("db-with-points");
  const dbPoints     = $("db-points");
  const dbDeleted    = $("db-deleted");
  const dbDeletedRow = $("db-deleted-row");
  const dbLast       = $("db-last");
  const dbLastRow    = $("db-last-row");
  const diffRow      = $("diff-row");
  const diffNew      = $("diff-new");
  const diffSame     = $("diff-same");
  const diffRemoved  = $("diff-removed");

  let pollTimer = null;

  fileInput?.addEventListener("change", () => {
    uploadBtn.disabled = !fileInput.files?.length;
  });

  uploadBtn?.addEventListener("click", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    startUpload(file);
  });

  function startUpload(file) {
    statusCard.hidden = false;
    statusTitle.textContent = `Uploading ${file.name}…`;
    uploadBtn.disabled = true;
    fileInput.disabled = true;
    setBar(uploadBar, 0);
    setBar(csvBar, 0);
    setBar(tracksBar, 0);
    uploadPct.textContent = "0%";
    csvCount.textContent = "0 / 0";
    tracksCount.textContent = "0 / 0";
    pointsLine.textContent = "";
    errorsDetails.hidden = true;
    errorsList.innerHTML = "";

    const form = new FormData();
    form.append("archive", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/strava/upload");
    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      setBar(uploadBar, pct);
      uploadPct.textContent = `${pct}%`;
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setBar(uploadBar, 100, "done");
        uploadPct.textContent = "100%";
        statusTitle.textContent = "Ingesting…";
        startPolling();
      } else {
        statusTitle.textContent = "Upload failed";
        setBar(uploadBar, 100, "error");
        try {
          const resp = JSON.parse(xhr.responseText);
          appendError(resp.error || xhr.statusText);
        } catch {
          appendError(`HTTP ${xhr.status} ${xhr.statusText}`);
        }
        fileInput.disabled = false;
        uploadBtn.disabled = !fileInput.files?.length;
      }
    });
    xhr.addEventListener("error", () => {
      statusTitle.textContent = "Upload error";
      setBar(uploadBar, 100, "error");
      appendError("network error during upload");
      fileInput.disabled = false;
    });
    xhr.send(form);
  }

  function startPolling() {
    poll();
    pollTimer = setInterval(poll, 1500);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function poll() {
    try {
      const resp = await fetch("/api/strava/status");
      if (!resp.ok) return;
      const s = await resp.json();
      render(s);
      if (s.status === "done" || s.status === "error") {
        stopPolling();
      }
    } catch (e) {
      // silently retry next tick
    }
  }

  function render(s) {
    // Pre-flight diff (computed before upserts during phase 1)
    if (s.activities_total > 0) {
      diffRow.hidden = false;
      diffNew.textContent     = (s.activities_new      || 0).toLocaleString();
      diffSame.textContent    = (s.activities_existing || 0).toLocaleString();
      diffRemoved.textContent = (s.activities_removed  || 0).toLocaleString();
    }

    // Activities phase
    const aTot = s.activities_total || 0;
    const aIns = s.activities_inserted || 0;
    csvCount.textContent = `${aIns.toLocaleString()} / ${aTot.toLocaleString()}`;
    setBar(csvBar, aTot ? (aIns / aTot) * 100 : 0, aTot && aIns === aTot ? "done" : "");

    // Tracks phase
    const tTot = s.tracks_total || 0;
    const tIns = s.tracks_parsed || 0;
    tracksCount.textContent = `${tIns.toLocaleString()} / ${tTot.toLocaleString()}`;
    setBar(tracksBar, tTot ? (tIns / tTot) * 100 : 0, tTot && tIns === tTot ? "done" : "");

    pointsLine.textContent = s.points_inserted
      ? `${s.points_inserted.toLocaleString()} track points inserted`
      : "";

    if (s.errors && s.errors.length) {
      errorsDetails.hidden = false;
      errorsSummary.textContent = `${s.errors.length} issue${s.errors.length === 1 ? "" : "s"} (click to expand)`;
      errorsList.innerHTML = s.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
    }

    if (s.db) {
      dbCard.hidden = false;
      dbActivities.textContent = (s.db.activities || 0).toLocaleString();
      dbWithPoints.textContent = (s.db.activities_with_points || 0).toLocaleString();
      dbPoints.textContent = (s.db.track_points || 0).toLocaleString();
      const deleted = s.db.deleted_from_strava || 0;
      dbDeleted.textContent = deleted.toLocaleString();
      dbDeletedRow.hidden = deleted === 0;
    }
    renderLastIngest(s.last_ingest);

    if (s.status === "done") {
      statusTitle.textContent = "Ingest complete";
      fileInput.disabled = false;
      uploadBtn.disabled = !fileInput.files?.length;
    } else if (s.status === "error") {
      statusTitle.textContent = "Ingest failed";
      setBar(csvBar, 100, "error");
      setBar(tracksBar, 100, "error");
      fileInput.disabled = false;
      uploadBtn.disabled = !fileInput.files?.length;
    } else if (s.status === "running") {
      statusTitle.textContent = s.phase === "tracks" ? "Parsing track files…" : "Reading activities.csv…";
    }
  }

  function renderLastIngest(li) {
    if (!li || !li.finished_at) {
      dbLastRow.hidden = true;
      return;
    }
    const d = new Date(li.finished_at);
    const rel = relativeTime(d);
    const ago = `${d.toLocaleDateString()} (${rel})`;
    dbLast.textContent = ago;
    dbLastRow.hidden = false;
  }

  function relativeTime(d) {
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60)            return `${sec}s ago`;
    if (sec < 3600)          return `${Math.round(sec / 60)} min ago`;
    if (sec < 86400)         return `${Math.round(sec / 3600)}h ago`;
    if (sec < 86400 * 30)    return `${Math.round(sec / 86400)}d ago`;
    if (sec < 86400 * 365)   return `${Math.round(sec / 86400 / 30)} mo ago`;
    return `${Math.round(sec / 86400 / 365)}y ago`;
  }

  function setBar(el, pct, cls = "") {
    el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    el.classList.remove("done", "error");
    if (cls) el.classList.add(cls);
  }

  function appendError(msg) {
    errorsDetails.hidden = false;
    const li = document.createElement("li");
    li.textContent = msg;
    errorsList.appendChild(li);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Show current DB state on page load (in case there's already data)
  fetch("/api/strava/status").then(r => r.ok ? r.json() : null).then(s => {
    if (s && s.db) {
      dbCard.hidden = false;
      dbActivities.textContent = (s.db.activities || 0).toLocaleString();
      dbWithPoints.textContent = (s.db.activities_with_points || 0).toLocaleString();
      dbPoints.textContent = (s.db.track_points || 0).toLocaleString();
      const deleted = s.db.deleted_from_strava || 0;
      dbDeleted.textContent = deleted.toLocaleString();
      dbDeletedRow.hidden = deleted === 0;
    }
    if (s) renderLastIngest(s.last_ingest);
    // If an ingest is mid-flight (e.g. user reloaded), pick up polling
    if (s && s.status === "running") {
      statusCard.hidden = false;
      setBar(uploadBar, 100, "done");
      uploadPct.textContent = "100%";
      startPolling();
    }
  }).catch(() => {});
})();
