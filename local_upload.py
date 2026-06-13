"""Save a user-uploaded or editor-produced GPX file as a 'local' activity row.

Locals get negative IDs (Strava IDs are always positive) and source='local'.
The original bytes are persisted under archives/local/ so we can re-download
them later — and so the user has a safety copy until ingest-side replacement
is proven out.
"""

import math
from datetime import datetime, timezone
from pathlib import Path

import gpxpy

import db


LOCAL_DIR = Path(__file__).parent / "archives" / "local"
LOCAL_DIR.mkdir(parents=True, exist_ok=True)


def _haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _summarize(points):
    """Compute the activity-level summary from the parsed track points.

    Returns a dict keyed to the activities-table columns. We don't try to
    detect 'moving vs stopped' — moving_time_s mirrors elapsed_time_s, which
    is good enough for filtering and will get replaced exactly when the
    Strava version of the same activity lands.
    """
    distance_m = 0.0
    elev_gain = 0.0
    elev_loss = 0.0
    elev_low  = None
    elev_high = None
    hrs       = []
    times     = []
    prev      = None

    for p in points:
        if p.get("time"):
            times.append(p["time"])
        e = p.get("elevation_m")
        if e is not None:
            if elev_low  is None or e < elev_low:  elev_low  = e
            if elev_high is None or e > elev_high: elev_high = e
        if p.get("hr"):
            hrs.append(p["hr"])
        if (prev is not None
                and p.get("lat") is not None and p.get("lon") is not None
                and prev.get("lat") is not None and prev.get("lon") is not None):
            distance_m += _haversine_m(prev["lat"], prev["lon"], p["lat"], p["lon"])
            pe, ce = prev.get("elevation_m"), p.get("elevation_m")
            if pe is not None and ce is not None:
                delta = ce - pe
                if delta > 0: elev_gain += delta
                else:         elev_loss += -delta
        prev = p

    if len(times) >= 2:
        t0 = datetime.fromisoformat(times[0])
        tN = datetime.fromisoformat(times[-1])
        elapsed_s = int((tN - t0).total_seconds())
    else:
        elapsed_s = None

    have_elev = elev_high is not None
    return {
        "start_time":       times[0] if times else None,
        "distance_m":       distance_m if points else None,
        "elapsed_time_s":   elapsed_s,
        "moving_time_s":    elapsed_s,
        "elevation_gain_m": elev_gain if have_elev else None,
        "elevation_loss_m": elev_loss if have_elev else None,
        "elevation_low_m":  elev_low,
        "elevation_high_m": elev_high,
        "avg_hr":           (sum(hrs) / len(hrs)) if hrs else None,
        "max_hr":           max(hrs)              if hrs else None,
        "avg_speed_mps":    (distance_m / elapsed_s) if (elapsed_s and elapsed_s > 0) else None,
    }


def _gpx_default_labels(gpx_bytes):
    """Pull a default name/type from the GPX (metadata.name, then trk.name/trk.type)."""
    try:
        gpx = gpxpy.parse(gpx_bytes.decode("utf-8", errors="replace"))
    except Exception:
        return None, None
    name = gpx.name
    type_ = None
    if gpx.tracks:
        tr = gpx.tracks[0]
        name = name or tr.name
        type_ = tr.type
    return name, type_


def _assign_local_id(conn):
    """Allocate the next negative ID. Caller must hold an open transaction."""
    row = conn.execute("SELECT MIN(id) FROM activities").fetchone()
    cur_min = row[0] if row[0] is not None else 0
    return min(cur_min, 0) - 1


_INSERT_COLS = [
    "id", "name", "type", "start_time",
    "distance_m", "elapsed_time_s", "moving_time_s",
    "elevation_gain_m", "elevation_loss_m",
    "elevation_low_m", "elevation_high_m",
    "avg_speed_mps", "avg_hr", "max_hr",
    "gear", "description",
    "source", "original_file_path",
    "has_points", "point_count", "imported_at",
]


def save_local_activity(gpx_bytes, name=None, type_=None, gear=None, description=None):
    """Persist a GPX file as a new source='local' activity. Returns the new id.

    Raises ValueError when the GPX has no usable track points.
    """
    # _parse_gpx_points lives in ingest.py — same parser as the Strava-zip path
    from ingest import _parse_gpx_points, _insert_track_points

    points = list(_parse_gpx_points(gpx_bytes))
    if not points:
        raise ValueError("GPX contains no track points")

    default_name, default_type = _gpx_default_labels(gpx_bytes)
    summary = _summarize(points)
    name  = (name  or default_name or "Unnamed activity").strip() or "Unnamed activity"
    type_ = (type_ or default_type or "Workout").strip() or "Workout"

    conn = db.connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        aid = _assign_local_id(conn)

        path = LOCAL_DIR / f"{abs(aid)}.gpx"
        path.write_bytes(gpx_bytes)

        values = [
            aid, name, type_, summary["start_time"],
            summary["distance_m"], summary["elapsed_time_s"], summary["moving_time_s"],
            summary["elevation_gain_m"], summary["elevation_loss_m"],
            summary["elevation_low_m"], summary["elevation_high_m"],
            summary["avg_speed_mps"], summary["avg_hr"], summary["max_hr"],
            gear, description,
            "local", str(path),
            1, len(points), datetime.now(timezone.utc).isoformat(),
        ]
        placeholders = ",".join("?" * len(_INSERT_COLS))
        conn.execute(
            f"INSERT INTO activities ({','.join(_INSERT_COLS)}) VALUES ({placeholders})",
            values,
        )
        _insert_track_points(conn, aid, points)

        # Run the SQL-only location pass so this row gets a 'Houston Third Ward'
        # / state-name label like everything else. Skip the heavyweight Python
        # reverse-geocoder fallback — db.init() runs it on the next restart.
        conn.execute(db.LOCATION_UPDATE_SQL)
        conn.execute("COMMIT")
        return aid
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
