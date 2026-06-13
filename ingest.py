"""Parse a Strava export zip into the SQLite store.

Phase 1: activities.csv → activities table (fast).
Phase 2: walk each activity's GPX/FIT file → track_points table.

The ingest runs in a background thread driven by app.py; progress is exposed
through the process-wide STATE object so /api/strava/status can poll it.
"""

import csv
import gzip
import io
import json
import traceback
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

import gpxpy
import fitdecode

from db import connect


# ───────────────────────────── CSV → activities ─────────────────────────────

# Strava's activities.csv ships with several duplicate headers (e.g. two
# "Distance" columns). csv.DictReader takes the last occurrence, which for
# distance/elevation/speed is the SI-unit version — exactly what we want.
ACTIVITIES_COL_MAP = {
    "activity id":          "id",
    "activity name":        "name",
    "activity type":        "type",
    "activity description": "description",
    "activity gear":        "gear",
    "filename":             "filename",
    "commute":              "commute",
    "calories":             "calories",
    "elapsed time":         "elapsed_time_s",
    "moving time":          "moving_time_s",
    "distance":             "distance_m",
    "max speed":            "max_speed_mps",
    "average speed":        "avg_speed_mps",
    "elevation gain":       "elevation_gain_m",
    "elevation loss":       "elevation_loss_m",
    "elevation low":        "elevation_low_m",
    "elevation high":       "elevation_high_m",
    "max heart rate":       "max_hr",
    "average heart rate":   "avg_hr",
    "max cadence":          "max_cadence",
    "average cadence":      "avg_cadence",
    "max watts":            "max_watts",
    "average watts":        "avg_watts",
    "max temperature":      "max_temp_c",
    "average temperature":  "avg_temp_c",
}

ACTIVITIES_TYPED = {
    "id":               int,
    "elapsed_time_s":   int,
    "moving_time_s":    int,
    "commute":          int,
    "distance_m":       float,
    "max_speed_mps":    float,
    "avg_speed_mps":    float,
    "elevation_gain_m": float,
    "elevation_loss_m": float,
    "elevation_low_m":  float,
    "elevation_high_m": float,
    "max_hr":           float,
    "avg_hr":           float,
    "max_cadence":      float,
    "avg_cadence":      float,
    "max_watts":        float,
    "avg_watts":        float,
    "max_temp_c":       float,
    "avg_temp_c":       float,
    "calories":         float,
}

_DATE_FORMATS = [
    "%b %d, %Y, %I:%M:%S %p",
    "%b %d, %Y, %I:%M %p",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%SZ",
]


def _parse_activity_date(s):
    if not s:
        return None
    s = s.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return s


def _coerce(value, py_type):
    if value is None or value == "":
        return None
    try:
        if py_type is int:
            if isinstance(value, str):
                v = value.strip().lower()
                if v == "true":
                    return 1
                if v == "false":
                    return 0
            return int(float(value))
        if py_type is float:
            return float(value)
    except (ValueError, TypeError):
        return None
    return value


def _row_to_activity(row):
    record = {dest: None for dest in set(ACTIVITIES_COL_MAP.values())}
    for header, value in row.items():
        dest = ACTIVITIES_COL_MAP.get(header)
        if dest is None:
            continue
        if dest in ACTIVITIES_TYPED:
            value = _coerce(value, ACTIVITIES_TYPED[dest])
        record[dest] = value
    record["start_time"]  = _parse_activity_date(row.get("activity date"))
    record["raw_csv"]     = json.dumps(row, ensure_ascii=False)
    record["imported_at"] = datetime.now(timezone.utc).isoformat()
    return record


def _read_csv_rows(zip_file, csv_name):
    with zip_file.open(csv_name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.reader(text)
        headers = [h.strip().lower() for h in next(reader)]
        for values in reader:
            # Duplicate headers: last value wins (matches csv.DictReader)
            row = {}
            for i, header in enumerate(headers):
                if i < len(values):
                    row[header] = values[i]
            yield row


def _find_activities_csv(zip_file):
    for name in zip_file.namelist():
        low = name.lower()
        if low == "activities.csv" or low.endswith("/activities.csv"):
            return name
    return None


_ACT_COLS = [
    "id", "name", "type", "start_time", "description",
    "distance_m", "elapsed_time_s", "moving_time_s",
    "elevation_gain_m", "elevation_loss_m", "elevation_low_m", "elevation_high_m",
    "avg_speed_mps", "max_speed_mps",
    "avg_hr", "max_hr", "avg_cadence", "max_cadence",
    "avg_watts", "max_watts", "calories", "avg_temp_c", "max_temp_c",
    "commute", "gear", "filename", "raw_csv", "imported_at",
]
_ACT_UPDATE = ",".join(f"{c}=excluded.{c}" for c in _ACT_COLS if c != "id")
_ACT_INSERT_SQL = (
    f"INSERT INTO activities ({','.join(_ACT_COLS)}) "
    f"VALUES ({','.join(['?'] * len(_ACT_COLS))}) "
    f"ON CONFLICT(id) DO UPDATE SET {_ACT_UPDATE}"
)


def _insert_activity(conn, record):
    conn.execute(_ACT_INSERT_SQL, [record.get(c) for c in _ACT_COLS])


# Max wall-clock gap allowed when matching a Strava CSV row to a previously-
# saved local activity. Device clocks and "started recording" / "first GPS fix"
# can drift this much — bigger window than needed for clean recordings, but
# small enough that two distinct rides within 2 min are vanishingly rare.
_LOCAL_MATCH_TOLERANCE_S = 120


def _link_local_to_strava(conn, strava_id, strava_start_time, strava_type):
    """Mark an unpaired local activity as superseded by this Strava row, if
    one matches within the tolerance window. Returns the local id (or None).

    Linking is bidirectional: the local gets replaced_by_id + replaced_at +
    deleted_from_strava=1 (so it drops out of the default browse view); the
    Strava row gets replaced_local_id + replaced_at (so its detail page can
    surface a 'replaced your local upload' banner).
    """
    if strava_id is None or not strava_start_time or not strava_type:
        return None
    row = conn.execute(
        """
        SELECT id FROM activities
         WHERE source = 'local'
           AND replaced_by_id IS NULL
           AND type = ?
           AND start_time IS NOT NULL
           AND ABS(strftime('%s', start_time) - strftime('%s', ?)) <= ?
         ORDER BY ABS(strftime('%s', start_time) - strftime('%s', ?))
         LIMIT 1
        """,
        (strava_type, strava_start_time, _LOCAL_MATCH_TOLERANCE_S, strava_start_time),
    ).fetchone()
    if not row:
        return None
    local_id = row[0]
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE activities "
        "   SET replaced_by_id=?, replaced_at=?, deleted_from_strava=1 "
        " WHERE id=?",
        (strava_id, now, local_id),
    )
    conn.execute(
        "UPDATE activities SET replaced_local_id=?, replaced_at=? WHERE id=?",
        (local_id, now, strava_id),
    )
    return local_id


# ───────────────────────────── GPX/FIT → points ─────────────────────────────


def _open_track_file(zip_file, member):
    with zip_file.open(member) as fh:
        data = fh.read()
    lower = member.lower()
    if lower.endswith(".gz"):
        data = gzip.decompress(data)
        lower = lower[:-3]
    if lower.endswith(".gpx"):
        return data, "gpx"
    if lower.endswith(".fit"):
        return data, "fit"
    if lower.endswith(".tcx"):
        return data, "tcx"
    return data, ""


def _gpx_ext_value(point, tag_names):
    """Look up a value under <extensions> in a gpxpy point by local tag name."""
    for ext in (point.extensions or []):
        stack = [ext]
        while stack:
            node = stack.pop()
            tag = node.tag.rsplit("}", 1)[-1].lower() if isinstance(node.tag, str) else ""
            if tag in tag_names and node.text:
                return node.text.strip()
            stack.extend(list(node))
    return None


_GPX_TRKPT_TAG = "{http://www.topografix.com/GPX/1/1}trkpt"
_EXTRA_FIELDS = (
    ("hr",            {"hr"},               int,   "hr"),
    ("cadence",       {"cad", "cadence"},   int,   "cadence"),
    ("power",         {"power", "watts"},   int,   "power"),
    ("temperature_c", {"atemp", "temp"},    float, "temperature_c"),
)


def _scan_trkpt_extras_blind(data):
    """Walk the raw GPX XML and pull HR / cadence / power / atemp values out of
    each <trkpt> regardless of which namespace the surrounding <extensions>
    block lives in. Returns a list aligned with trkpt document order.

    gpxpy ignores <extensions> blocks that aren't in the GPX namespace, which
    silently drops HR injected by the in-app GPX Editor (browsers emit
    xmlns="http://www.w3.org/1999/xhtml" on null-namespace elements). This
    fallback covers that — and any other tool that writes misnamespaced
    extensions — without changing the gpxpy-driven fast path.
    """
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    out = []
    for tp in root.iter(_GPX_TRKPT_TAG):
        extras = {dest: None for _, _, _, dest in _EXTRA_FIELDS}
        for elem in tp.iter():
            tag = elem.tag.rsplit("}", 1)[-1].lower() if isinstance(elem.tag, str) else ""
            for _, tags, cast, dest in _EXTRA_FIELDS:
                if tag in tags and extras[dest] is None and elem.text:
                    try:
                        extras[dest] = cast(float(elem.text.strip()))
                    except (ValueError, TypeError):
                        pass
        out.append(extras)
    return out


def _parse_gpx_points(data):
    gpx = gpxpy.parse(data.decode("utf-8", errors="replace"))
    points = []
    for track in gpx.tracks:
        for segment in track.segments:
            for p in segment.points:
                def _f(tags, cast):
                    raw = _gpx_ext_value(p, tags)
                    if raw is None:
                        return None
                    try:
                        return cast(float(raw))
                    except (ValueError, TypeError):
                        return None
                points.append({
                    "sequence":      len(points),
                    "time":          p.time.isoformat() if p.time else None,
                    "lat":           p.latitude,
                    "lon":           p.longitude,
                    "elevation_m":   p.elevation,
                    "hr":            _f({"hr"},               int),
                    "cadence":       _f({"cad", "cadence"},   int),
                    "power":         _f({"power", "watts"},   int),
                    "temperature_c": _f({"atemp", "temp"},    float),
                })

    if any(pt.get(k) is None for pt in points for _, _, _, k in _EXTRA_FIELDS):
        blind = _scan_trkpt_extras_blind(data)
        for i, pt in enumerate(points):
            if i >= len(blind):
                break
            for _, _, _, dest in _EXTRA_FIELDS:
                if pt.get(dest) is None and blind[i].get(dest) is not None:
                    pt[dest] = blind[i][dest]

    for pt in points:
        yield pt


def _semi_to_deg(v):
    """FIT positions are int32 semicircles; convert to degrees."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # Already degrees if within plausible range
    if -360 <= f <= 360:
        return f
    return f * (180.0 / (2 ** 31))


def _parse_fit_points(data):
    seq = 0
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
            yield {
                "sequence":      seq,
                "time":          ts.isoformat() if hasattr(ts, "isoformat") else None,
                "lat":           _semi_to_deg(g("position_lat")),
                "lon":           _semi_to_deg(g("position_long")),
                "elevation_m":   g("enhanced_altitude") if g("enhanced_altitude") is not None else g("altitude"),
                "hr":            g("heart_rate"),
                "cadence":       g("cadence"),
                "power":         g("power"),
                "temperature_c": g("temperature"),
            }
            seq += 1


def _insert_track_points(conn, activity_id, points):
    conn.execute("DELETE FROM track_points WHERE activity_id=?", (activity_id,))
    rows = [
        (
            activity_id,
            p["sequence"], p["time"], p["lat"], p["lon"], p["elevation_m"],
            p["hr"], p["cadence"], p["power"], p["temperature_c"],
        )
        for p in points
    ]
    if rows:
        conn.executemany(
            "INSERT INTO track_points (activity_id, sequence, time, lat, lon, "
            "elevation_m, hr, cadence, power, temperature_c) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    return len(rows)


# ───────────────────────────── Orchestration ─────────────────────────────


class IngestState:
    """Process-wide mutable status tracker. Read via snapshot()."""

    def __init__(self):
        self.lock = Lock()
        self.reset()

    def reset(self):
        self.status = "idle"          # idle | running | done | error
        self.phase = "idle"           # idle | csv | tracks | done
        self.activities_total = 0
        self.activities_inserted = 0
        self.activities_new = 0       # not seen in any prior ingest
        self.activities_existing = 0  # already in DB
        self.activities_removed = 0   # in DB but missing from this CSV
        self.locals_replaced = 0      # local rows linked to a Strava row this run
        self.tracks_total = 0
        self.tracks_parsed = 0
        self.points_inserted = 0
        self.errors = []
        self.zip_path = None
        self.started_at = None
        self.finished_at = None

    def snapshot(self):
        with self.lock:
            return {
                "status":              self.status,
                "phase":               self.phase,
                "activities_total":    self.activities_total,
                "activities_inserted": self.activities_inserted,
                "activities_new":      self.activities_new,
                "activities_existing": self.activities_existing,
                "activities_removed":  self.activities_removed,
                "locals_replaced":     self.locals_replaced,
                "tracks_total":        self.tracks_total,
                "tracks_parsed":       self.tracks_parsed,
                "points_inserted":     self.points_inserted,
                "errors":              list(self.errors[-50:]),
                "zip_path":            self.zip_path,
                "started_at":          self.started_at,
                "finished_at":         self.finished_at,
            }


STATE = IngestState()


def _delete_other_zips(keep_path):
    """After a successful ingest, remove all *.zip in archives/ except keep_path."""
    keep = Path(keep_path).resolve()
    for p in keep.parent.glob("*.zip"):
        try:
            if p.resolve() != keep:
                p.unlink()
        except OSError:
            pass


def _record_run_start(conn, zip_path):
    cur = conn.execute(
        "INSERT INTO ingest_runs (started_at, zip_path, status, phase) "
        "VALUES (?, ?, 'running', 'csv')",
        (datetime.now(timezone.utc).isoformat(), str(zip_path)),
    )
    return cur.lastrowid


def _record_run_end(conn, run_id, status):
    snap = STATE.snapshot()
    conn.execute(
        "UPDATE ingest_runs SET finished_at=?, status=?, phase=?, "
        "activities_total=?, activities_inserted=?, "
        "tracks_total=?, tracks_parsed=?, points_inserted=?, errors_json=? "
        "WHERE id=?",
        (
            datetime.now(timezone.utc).isoformat(),
            status,
            snap["phase"],
            snap["activities_total"],
            snap["activities_inserted"],
            snap["tracks_total"],
            snap["tracks_parsed"],
            snap["points_inserted"],
            json.dumps(snap["errors"][-50:], ensure_ascii=False) if snap["errors"] else None,
            run_id,
        ),
    )


def run_ingest(zip_path):
    zip_path = Path(zip_path)
    with STATE.lock:
        STATE.reset()
        STATE.status = "running"
        STATE.phase = "csv"
        STATE.zip_path = str(zip_path)
        STATE.started_at = datetime.now(timezone.utc).isoformat()

    run_id = None
    try:
        with zipfile.ZipFile(zip_path) as zf:
            csv_name = _find_activities_csv(zf)
            if not csv_name:
                raise RuntimeError("activities.csv not found in archive")

            # ── Phase 1: activities.csv ────────────────────────────────
            records = []
            for row in _read_csv_rows(zf, csv_name):
                records.append(_row_to_activity(row))
            with STATE.lock:
                STATE.activities_total = len(records)

            conn = connect()
            try:
                run_id = _record_run_start(conn, zip_path)

                # Pre-flight diff: how many CSV IDs are new vs already in DB,
                # and which DB IDs are missing from this archive (deleted on Strava).
                csv_ids = {r["id"] for r in records if r.get("id") is not None}
                db_ids = {
                    row[0] for row in conn.execute("SELECT id FROM activities")
                }
                new_ids     = csv_ids - db_ids
                existing_ids = csv_ids & db_ids
                removed_ids = db_ids - csv_ids
                with STATE.lock:
                    STATE.activities_new      = len(new_ids)
                    STATE.activities_existing = len(existing_ids)
                    STATE.activities_removed  = len(removed_ids)

                conn.execute("BEGIN")
                for rec in records:
                    try:
                        _insert_activity(conn, rec)
                        linked = _link_local_to_strava(
                            conn,
                            rec.get("id"),
                            rec.get("start_time"),
                            rec.get("type"),
                        )
                        with STATE.lock:
                            STATE.activities_inserted += 1
                            if linked is not None:
                                STATE.locals_replaced += 1
                    except Exception as e:
                        with STATE.lock:
                            STATE.errors.append(f"activity {rec.get('id')}: {e}")
                # Anything present in this CSV is, by definition, not deleted —
                # clear the flag for resurrected activities.
                if csv_ids:
                    placeholders = ",".join("?" * len(csv_ids))
                    conn.execute(
                        f"UPDATE activities SET deleted_from_strava=0 "
                        f"WHERE id IN ({placeholders})",
                        list(csv_ids),
                    )
                # Mark anything in DB but not in this CSV as removed
                if removed_ids:
                    placeholders = ",".join("?" * len(removed_ids))
                    conn.execute(
                        f"UPDATE activities SET deleted_from_strava=1 "
                        f"WHERE id IN ({placeholders})",
                        list(removed_ids),
                    )
                conn.execute("COMMIT")
            finally:
                conn.close()

            # ── Phase 2: track points ──────────────────────────────────
            with STATE.lock:
                STATE.phase = "tracks"

            conn = connect()
            try:
                rows = conn.execute(
                    "SELECT id, filename FROM activities "
                    "WHERE filename IS NOT NULL AND filename != '' "
                    "  AND has_points = 0"
                ).fetchall()
                with STATE.lock:
                    STATE.tracks_total = len(rows)

                names_lower = {n.lower(): n for n in zf.namelist()}

                for row in rows:
                    aid = row["id"]
                    fname = row["filename"]
                    member = names_lower.get(fname.lower())
                    if not member:
                        # Some zips prefix everything with export_<athleteid>/
                        needle = "/" + fname.lower()
                        for n_lower, n_real in names_lower.items():
                            if n_lower.endswith(needle):
                                member = n_real
                                break
                    if not member:
                        with STATE.lock:
                            STATE.errors.append(
                                f"activity {aid}: file not found in zip ({fname})"
                            )
                            STATE.tracks_parsed += 1
                        continue
                    try:
                        data, ext = _open_track_file(zf, member)
                        if ext == "gpx":
                            points = list(_parse_gpx_points(data))
                        elif ext == "fit":
                            points = list(_parse_fit_points(data))
                        else:
                            points = []
                        conn.execute("BEGIN")
                        inserted = _insert_track_points(conn, aid, points)
                        conn.execute(
                            "UPDATE activities SET has_points=?, point_count=? WHERE id=?",
                            (1 if inserted else 0, inserted, aid),
                        )
                        # Backfill max_hr from this activity's track points if the
                        # CSV value was missing or zero (Strava rarely fills it in).
                        conn.execute("""
                            UPDATE activities
                               SET max_hr = COALESCE(
                                   (SELECT MAX(hr) FROM track_points
                                     WHERE activity_id = ? AND hr > 0),
                                   max_hr)
                             WHERE id = ? AND (max_hr IS NULL OR max_hr = 0)
                        """, (aid, aid))
                        conn.execute("COMMIT")
                        with STATE.lock:
                            STATE.points_inserted += inserted
                    except Exception as e:
                        try:
                            conn.execute("ROLLBACK")
                        except Exception:
                            pass
                        with STATE.lock:
                            STATE.errors.append(
                                f"activity {aid}: {type(e).__name__}: {e}"
                            )
                    finally:
                        with STATE.lock:
                            STATE.tracks_parsed += 1
            finally:
                conn.close()

        # Re-run derived-data backfills now that this archive is in.
        # Same order as db.init(): clean bad HR → backfill max_hr → clean zero
        # avg_hr → re-classify locations.
        conn = connect()
        try:
            from db import (
                LOCATION_UPDATE_SQL,
                run_hr_cleanup,
                run_max_hr_backfill,
                run_avg_hr_cleanup,
                run_geo_classification,
            )
            run_hr_cleanup(conn)
            run_max_hr_backfill(conn)
            run_avg_hr_cleanup(conn)
            conn.execute(LOCATION_UPDATE_SQL)
            run_geo_classification(conn)
        finally:
            conn.close()

        with STATE.lock:
            STATE.status = "done"
            STATE.phase = "done"
            STATE.finished_at = datetime.now(timezone.utc).isoformat()

        if run_id is not None:
            conn = connect()
            try:
                _record_run_end(conn, run_id, "done")
            finally:
                conn.close()

        # Successful ingest → drop earlier zips to reclaim disk
        _delete_other_zips(zip_path)
    except Exception as e:
        with STATE.lock:
            STATE.status = "error"
            STATE.errors.append(
                f"FATAL: {type(e).__name__}: {e}\n{traceback.format_exc()}"
            )
            STATE.finished_at = datetime.now(timezone.utc).isoformat()

        if run_id is not None:
            try:
                conn = connect()
                try:
                    _record_run_end(conn, run_id, "error")
                finally:
                    conn.close()
            except Exception:
                pass
