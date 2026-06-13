import io
import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Thread

import fitdecode
from flask import Flask, abort, jsonify, render_template, request

import db
from ingest import STATE, run_ingest

ARCHIVES_DIR = Path(__file__).parent / "archives"
ARCHIVES_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
# Strava archives can be a few GB for active users.
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024 * 1024  # 5 GB

db.init()


@app.route("/")
def home():
    return render_template("home.html")


@app.route("/gpx_editor")
def gpx_editor():
    return render_template("gpx_editor.html")


def _fit_hr_samples(data):
    """Extract (timestamp, heart_rate) samples from raw .fit bytes.

    Returns a list of {"t": <epoch_ms_utc>, "hr": <int>} sorted by time,
    including only records that carry both a timestamp and an HR value.
    """
    samples = []
    with fitdecode.FitReader(io.BytesIO(data)) as reader:
        for frame in reader:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            if frame.name != "record":
                continue

            def g(field):
                try:
                    return frame.get_value(field)
                except (KeyError, ValueError, AttributeError):
                    return None

            ts = g("timestamp")
            hr = g("heart_rate")
            if ts is None or hr is None or not hasattr(ts, "timestamp"):
                continue
            try:
                hr_int = int(hr)
            except (TypeError, ValueError):
                continue
            # 0/negative HR means "no sensor" (common in Zwift exports without a
            # strap) — treat as no data so we don't emit bogus 0-bpm samples.
            if hr_int <= 0:
                continue
            # FIT timestamps are UTC; normalize to epoch milliseconds so the
            # browser can match them against GPX <time> values directly.
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            samples.append({"t": int(ts.timestamp() * 1000), "hr": hr_int})

    samples.sort(key=lambda s: s["t"])
    return samples


@app.post("/api/fit/hr")
def fit_hr():
    """Parse an uploaded .fit and return its heart-rate samples by time.

    Used by the GPX Editor to merge HR data into a GPX that lacks it.
    """
    uploaded = request.files.get("fit")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "no file uploaded (field: fit)"}), 400
    if not uploaded.filename.lower().endswith(".fit"):
        return jsonify({"error": "expected a .fit file"}), 400

    try:
        samples = _fit_hr_samples(uploaded.read())
    except Exception as exc:  # noqa: BLE001 - report parse failure to client
        return jsonify({"error": f"could not parse .fit file: {exc}"}), 400

    if not samples:
        return jsonify({
            "error": "no heart-rate data found in this .fit file",
            "samples": [], "count": 0,
        }), 200

    hrs = [s["hr"] for s in samples]
    return jsonify({
        "samples": samples,
        "count":   len(samples),
        "hr_min":  min(hrs),
        "hr_max":  max(hrs),
        "t_start": samples[0]["t"],
        "t_end":   samples[-1]["t"],
    })


@app.route("/strava_archive")
def strava_archive():
    return render_template("strava_archive.html")


@app.post("/api/strava/upload")
def strava_upload():
    if STATE.snapshot()["status"] == "running":
        return jsonify({"error": "ingest already in progress"}), 409

    uploaded = request.files.get("archive")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "no file uploaded (field: archive)"}), 400
    if not uploaded.filename.lower().endswith(".zip"):
        return jsonify({"error": "expected a .zip"}), 400

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = ARCHIVES_DIR / f"strava-{ts}.zip"
    uploaded.save(dest)

    thread = Thread(target=run_ingest, args=(dest,), daemon=True)
    thread.start()

    return jsonify({"ok": True, "zip_path": str(dest)}), 202


@app.get("/api/strava/status")
def strava_status():
    snap = STATE.snapshot()
    snap["db"] = db.counts()
    snap["last_ingest"] = db.last_ingest()
    return jsonify(snap)


@app.route("/strava_archive/browse")
def strava_archive_browse():
    return render_template("strava_archive_browse.html")


_SORT_MAP = {
    "date_desc":      "start_time DESC",
    "date_asc":       "start_time ASC",
    "distance_desc":  "distance_m DESC",
    "distance_asc":   "distance_m ASC",
    "time_desc":      "moving_time_s DESC",
    "time_asc":       "moving_time_s ASC",
    "elevation_desc": "elevation_gain_m DESC",
    "elevation_asc":  "elevation_gain_m ASC",
    "name_asc":       "name COLLATE NOCASE ASC",
}


@app.get("/api/strava/activities")
def strava_activities():
    a = request.args
    where, params = [], []

    # Hide activities that were in a prior export but not in the most recent one
    if a.get("include_deleted") != "1":
        where.append("deleted_from_strava = 0")

    types = a.getlist("type")
    if types:
        where.append("type IN (" + ",".join("?" * len(types)) + ")")
        params.extend(types)

    gears = a.getlist("gear")
    if gears:
        where.append("gear IN (" + ",".join("?" * len(gears)) + ")")
        params.extend(gears)

    locations = a.getlist("location")
    if locations:
        where.append("location IN (" + ",".join("?" * len(locations)) + ")")
        params.extend(locations)

    if a.get("has_hr") == "1":
        where.append("avg_hr IS NOT NULL AND avg_hr > 0")

    if a.get("has_elev") == "1":
        where.append("elevation_gain_m IS NOT NULL")

    q = (a.get("q") or "").strip()
    if q:
        where.append("(name LIKE ? OR COALESCE(description,'') LIKE ?)")
        qp = f"%{q}%"
        params.extend([qp, qp])

    def _range(arg_min, arg_max, col, cast=float, null_as=None):
        lo = a.get(arg_min, type=cast)
        hi = a.get(arg_max, type=cast)
        expr = col if null_as is None else f"COALESCE({col}, {null_as})"
        if lo is not None:
            where.append(f"{expr} >= ?"); params.append(lo)
        if hi is not None:
            where.append(f"{expr} <= ?"); params.append(hi)

    _range("min_distance_m",  "max_distance_m",  "distance_m")
    _range("min_time_s",      "max_time_s",      "moving_time_s", int)
    # Manual entries have NULL elevation_gain_m; treat them as 0 so they don't
    # vanish the moment the slider is touched (use "Has elevation data" to
    # filter them out explicitly).
    _range("min_elevation_m", "max_elevation_m", "elevation_gain_m", null_as=0)

    start_date = a.get("start_date")
    end_date   = a.get("end_date")
    if start_date:
        where.append("start_time >= ?"); params.append(start_date)
    if end_date:
        where.append("start_time <= ?"); params.append(end_date + "T23:59:59+00:00")

    hour_min = a.get("hour_min", type=int)
    hour_max = a.get("hour_max", type=int)
    if hour_min is not None or hour_max is not None:
        hm = 0  if hour_min is None else hour_min
        hM = 23 if hour_max is None else hour_max
        if hm <= hM:
            where.append("CAST(strftime('%H', start_time) AS INTEGER) BETWEEN ? AND ?")
            params.extend([hm, hM])
        else:
            # wraparound (e.g. 22 → 6)
            where.append(
                "(CAST(strftime('%H', start_time) AS INTEGER) >= ? "
                " OR CAST(strftime('%H', start_time) AS INTEGER) <= ?)"
            )
            params.extend([hm, hM])

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    sort_sql  = _SORT_MAP.get(a.get("sort", "date_desc"), "start_time DESC")
    limit     = min(max(1, int(a.get("limit", 50))), 500)
    offset    = max(0, int(a.get("offset", 0)))

    conn = db.connect()
    try:
        total = conn.execute(
            f"SELECT COUNT(*) FROM activities {where_sql}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"""SELECT id, name, type, start_time, distance_m,
                       moving_time_s, elapsed_time_s, elevation_gain_m,
                       avg_hr, max_hr, avg_watts, has_points, point_count,
                       location
                  FROM activities {where_sql}
                 ORDER BY {sort_sql}
                 LIMIT ? OFFSET ?""",
            params + [limit, offset],
        ).fetchall()
        return jsonify({
            "total":   total,
            "limit":   limit,
            "offset":  offset,
            "results": [dict(r) for r in rows],
        })
    finally:
        conn.close()


@app.route("/strava_archive/activity/<int:activity_id>")
def strava_activity_page(activity_id):
    return render_template("strava_archive_activity.html", activity_id=activity_id)


@app.get("/api/strava/activities/<int:activity_id>")
def strava_activity_detail(activity_id):
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT * FROM activities WHERE id=?", (activity_id,)
        ).fetchone()
        if not row:
            abort(404)
        activity = dict(row)
        if activity.get("raw_csv"):
            try:
                activity["raw_csv"] = json.loads(activity["raw_csv"])
            except (ValueError, TypeError):
                pass
        points = [
            dict(p) for p in conn.execute(
                "SELECT sequence, time, lat, lon, elevation_m, hr, cadence, power, temperature_c "
                "FROM track_points WHERE activity_id=? ORDER BY sequence",
                (activity_id,),
            )
        ]
        return jsonify({"activity": activity, "points": points})
    finally:
        conn.close()


@app.get("/api/strava/activities/facets")
def strava_activities_facets():
    """Slider bounds + type counts for the browse-page filter UI."""
    conn = db.connect()
    try:
        types = [
            {"type": r["type"], "count": r["c"]}
            for r in conn.execute(
                "SELECT type, COUNT(*) c FROM activities "
                "WHERE type IS NOT NULL AND type != '' AND deleted_from_strava=0 "
                "GROUP BY type ORDER BY c DESC"
            )
        ]
        # Sort gear pills so bike gear (Ride / Virtual Ride / E-Bike) comes
        # before shoe gear (Run / Walk / Hike), then by count within each group.
        # Primary activity type per gear = the type with the highest count.
        gear_primary = {}
        for r in conn.execute(
            "SELECT gear, type, COUNT(*) c FROM activities "
            "WHERE gear IS NOT NULL AND gear != '' "
            "  AND deleted_from_strava=0 "
            "GROUP BY gear, type"
        ):
            g, t, c = r["gear"], r["type"], r["c"]
            if g not in gear_primary or c > gear_primary[g][1]:
                gear_primary[g] = (t, c)

        _TYPE_GROUP_ORDER = {
            "Ride": 0, "Virtual Ride": 1, "E-Bike Ride": 2,
            "Run":  3, "Walk": 4, "Hike": 5, "Swim": 6,
        }
        gears_raw = [
            {"gear": r["gear"], "count": r["c"]}
            for r in conn.execute(
                "SELECT gear, COUNT(*) c FROM activities "
                "WHERE gear IS NOT NULL AND gear != '' AND deleted_from_strava=0 "
                "GROUP BY gear"
            )
        ]
        gears = sorted(
            gears_raw,
            key=lambda g: (
                _TYPE_GROUP_ORDER.get(gear_primary.get(g["gear"], ("", 0))[0], 99),
                -g["count"],
            ),
        )
        # Locations sorted by count desc; NULLs (unclassified) excluded so they
        # don't show up as a blank pill — user can still see them by clearing
        # all location filters
        locations = [
            {"location": r["location"], "count": r["c"]}
            for r in conn.execute(
                "SELECT location, COUNT(*) c FROM activities "
                "WHERE location IS NOT NULL AND deleted_from_strava=0 "
                "GROUP BY location ORDER BY c DESC"
            )
        ]
        has_hr_count = conn.execute(
            "SELECT COUNT(*) FROM activities "
            "WHERE avg_hr IS NOT NULL AND avg_hr > 0 AND deleted_from_strava=0"
        ).fetchone()[0]
        has_elev_count = conn.execute(
            "SELECT COUNT(*) FROM activities "
            "WHERE elevation_gain_m IS NOT NULL AND deleted_from_strava=0"
        ).fetchone()[0]
        r = conn.execute(
            "SELECT MIN(distance_m) min_d, MAX(distance_m) max_d, "
            "       MIN(moving_time_s) min_t, MAX(moving_time_s) max_t, "
            "       MIN(elevation_gain_m) min_e, MAX(elevation_gain_m) max_e, "
            "       MIN(date(start_time)) min_date, MAX(date(start_time)) max_date "
            "  FROM activities WHERE deleted_from_strava=0"
        ).fetchone()
        total = conn.execute(
            "SELECT COUNT(*) FROM activities WHERE deleted_from_strava=0"
        ).fetchone()[0]
        deleted = conn.execute(
            "SELECT COUNT(*) FROM activities WHERE deleted_from_strava=1"
        ).fetchone()[0]
        return jsonify({
            "total":         total,
            "deleted":       deleted,
            "types":         types,
            "gears":          gears,
            "locations":      locations,
            "has_hr_count":   has_hr_count,
            "has_elev_count": has_elev_count,
            "distance_m":    {"min": r["min_d"] or 0, "max": r["max_d"] or 0},
            "moving_time_s": {"min": r["min_t"] or 0, "max": r["max_t"] or 0},
            "elevation_m":   {"min": r["min_e"] or 0, "max": r["max_e"] or 0},
            "date":          {"min": r["min_date"], "max": r["max_date"]},
        })
    finally:
        conn.close()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5052, debug=False)
