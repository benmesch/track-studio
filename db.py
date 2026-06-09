"""SQLite schema + connection helpers for the Strava archive store."""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "strava_archive.db"


SCHEMA = """
CREATE TABLE IF NOT EXISTS activities (
    id              INTEGER PRIMARY KEY,
    name            TEXT,
    type            TEXT,
    start_time      TEXT,
    description     TEXT,
    distance_m      REAL,
    elapsed_time_s  INTEGER,
    moving_time_s   INTEGER,
    elevation_gain_m REAL,
    elevation_loss_m REAL,
    elevation_low_m  REAL,
    elevation_high_m REAL,
    avg_speed_mps   REAL,
    max_speed_mps   REAL,
    avg_hr          REAL,
    max_hr          REAL,
    avg_cadence     REAL,
    max_cadence     REAL,
    avg_watts       REAL,
    max_watts       REAL,
    calories        REAL,
    avg_temp_c      REAL,
    max_temp_c      REAL,
    commute         INTEGER,
    gear            TEXT,
    filename        TEXT,
    has_points      INTEGER NOT NULL DEFAULT 0,
    point_count     INTEGER NOT NULL DEFAULT 0,
    raw_csv         TEXT,
    imported_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_activities_start_time ON activities(start_time);
CREATE INDEX IF NOT EXISTS idx_activities_type       ON activities(type);

CREATE TABLE IF NOT EXISTS track_points (
    activity_id   INTEGER NOT NULL,
    sequence      INTEGER NOT NULL,
    time          TEXT,
    lat           REAL,
    lon           REAL,
    elevation_m   REAL,
    hr            INTEGER,
    cadence       INTEGER,
    power         INTEGER,
    temperature_c REAL,
    PRIMARY KEY (activity_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_track_points_activity ON track_points(activity_id);

CREATE TABLE IF NOT EXISTS ingest_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at           TEXT,
    finished_at          TEXT,
    zip_path             TEXT,
    status               TEXT,
    phase                TEXT,
    activities_total     INTEGER DEFAULT 0,
    activities_inserted  INTEGER DEFAULT 0,
    tracks_total         INTEGER DEFAULT 0,
    tracks_parsed        INTEGER DEFAULT 0,
    points_inserted      INTEGER DEFAULT 0,
    errors_json          TEXT
);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_column(conn, table, col, ddl):
    existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    if col not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def init():
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        _ensure_column(conn, "activities", "deleted_from_strava",
                       "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "activities", "location", "TEXT")
        run_hr_cleanup(conn)
        run_max_hr_backfill(conn)
        run_avg_hr_cleanup(conn)
        conn.execute(LOCATION_UPDATE_SQL)
        run_geo_classification(conn)
    finally:
        conn.close()


# Activities whose HR sensor was malfunctioning — readings drift continuously
# upward to physiologically impossible values (>220 bpm). Treat as if no HR
# was recorded at all. Add new IDs here when more sensor failures are found.
BAD_HR_ACTIVITY_IDS = (
    7566653984,  # 2022-08-01 Zwift - hour at 75 percent on Douce France
    7573635027,  # 2022-08-03 Zwift - hour at 75 percent on Road to Sky
    7584015152,  # 2022-08-04 Zwift - hour at 80 percent on Muir And The Mountain
)


def run_hr_cleanup(conn):
    """Wipe HR for known-bad sensor activities, both at the track-point and
    activity-summary levels. Idempotent."""
    if not BAD_HR_ACTIVITY_IDS:
        return
    placeholders = ",".join("?" * len(BAD_HR_ACTIVITY_IDS))
    conn.execute(
        f"UPDATE track_points SET hr = NULL "
        f" WHERE activity_id IN ({placeholders}) AND hr IS NOT NULL",
        BAD_HR_ACTIVITY_IDS,
    )
    conn.execute(
        f"UPDATE activities SET avg_hr = NULL, max_hr = NULL "
        f" WHERE id IN ({placeholders}) AND (avg_hr IS NOT NULL OR max_hr IS NOT NULL)",
        BAD_HR_ACTIVITY_IDS,
    )


def run_max_hr_backfill(conn):
    """Strava CSV rarely populates max_hr. Derive it from track points.
    Only touches NULL or zero values; never overwrites a real CSV value."""
    conn.execute("""
        UPDATE activities
           SET max_hr = COALESCE(
               (SELECT MAX(hr) FROM track_points
                 WHERE activity_id = activities.id AND hr > 0),
               max_hr)
         WHERE max_hr IS NULL OR max_hr = 0
    """)


def run_avg_hr_cleanup(conn):
    """avg_hr=0 from Strava CSV means 'no HR sensor connected' (typical for
    Zwift Camp rides). If there's also no real track-point HR data, NULL it
    out — the activity simply has no HR data, not zero HR."""
    conn.execute("""
        UPDATE activities
           SET avg_hr = NULL
         WHERE avg_hr = 0
           AND NOT EXISTS (
               SELECT 1 FROM track_points
                WHERE activity_id = activities.id AND hr > 0
           )
    """)


# Classification rules — keep in sync with ingest re-run. Boxes can be widened
# later if real activities start at unmatched coords inside the same area.
# Most-specific buckets first; anything that falls through gets state/country
# from run_geo_classification() in the Python pass below.
LOCATION_UPDATE_SQL = """
UPDATE activities SET location = CASE
  WHEN type = 'Virtual Ride' THEN 'Zwift'
  WHEN NOT EXISTS (
    SELECT 1 FROM track_points tp
     WHERE tp.activity_id = activities.id AND tp.lat IS NOT NULL LIMIT 1
  ) THEN CASE
    WHEN type = 'Run'  THEN 'Treadmill'
    WHEN type = 'Swim' THEN 'Pool'
    ELSE NULL
  END
  ELSE (
    SELECT CASE
      -- Home neighborhoods (tight boxes)
      WHEN lat BETWEEN 29.70 AND 29.74
       AND lon BETWEEN -95.40 AND -95.34 THEN 'Houston Third Ward'
      WHEN lat BETWEEN 47.10 AND 47.22
       AND lon BETWEEN -122.30 AND -122.10 THEN 'Bonney Lake WA'
      -- Wider metro areas
      WHEN lat BETWEEN 47.40 AND 47.78
       AND lon BETWEEN -122.50 AND -122.18 THEN 'Seattle WA'
      WHEN lat BETWEEN 29.40 AND 30.10
       AND lon BETWEEN -95.85 AND -94.85 THEN 'Houston TX'
      ELSE NULL  -- Python pass fills in state (US) or country
    END
    FROM track_points
    WHERE activity_id = activities.id AND lat IS NOT NULL
    ORDER BY sequence LIMIT 1
  )
END
"""


# Pretty country names for the geo fallback. Add entries as new destinations
# show up; unmapped codes fall through as the 2-letter code (visible flag).
COUNTRY_NAMES = {
    'US': 'United States', 'CA': 'Canada', 'MX': 'Mexico',
    'GB': 'United Kingdom', 'IE': 'Ireland',
    'FR': 'France', 'ES': 'Spain', 'IT': 'Italy', 'PT': 'Portugal',
    'DE': 'Germany', 'NL': 'Netherlands', 'BE': 'Belgium', 'CH': 'Switzerland',
    'AT': 'Austria', 'CZ': 'Czechia', 'PL': 'Poland', 'HU': 'Hungary',
    'GR': 'Greece', 'HR': 'Croatia', 'TR': 'Turkey',
    'DK': 'Denmark', 'SE': 'Sweden', 'NO': 'Norway', 'FI': 'Finland', 'IS': 'Iceland',
    'AU': 'Australia', 'NZ': 'New Zealand',
    'JP': 'Japan', 'CN': 'China', 'KR': 'South Korea', 'TW': 'Taiwan', 'HK': 'Hong Kong',
    'TH': 'Thailand', 'VN': 'Vietnam', 'ID': 'Indonesia', 'MY': 'Malaysia',
    'SG': 'Singapore', 'PH': 'Philippines', 'IN': 'India',
    'BR': 'Brazil', 'AR': 'Argentina', 'CL': 'Chile', 'PE': 'Peru', 'CO': 'Colombia',
    'IL': 'Israel', 'AE': 'UAE', 'ZA': 'South Africa', 'EG': 'Egypt', 'KE': 'Kenya',
}


def run_geo_classification(conn):
    """For activities still unclassified after LOCATION_UPDATE_SQL, look up
    state (US) or country (non-US) via offline reverse-geocoding. No-op if
    nothing needs it — avoids loading the kd-tree on every restart."""
    rows = conn.execute("""
        SELECT a.id, tp.lat, tp.lon
          FROM activities a
          JOIN track_points tp ON tp.activity_id = a.id
         WHERE a.location IS NULL
           AND a.deleted_from_strava = 0
           AND tp.lat IS NOT NULL
           AND tp.sequence = (
               SELECT MIN(sequence) FROM track_points
                WHERE activity_id = a.id AND lat IS NOT NULL
           )
    """).fetchall()
    if not rows:
        return
    import reverse_geocoder as rg
    coords = [(r[1], r[2]) for r in rows]
    results = rg.search(coords, mode=1)
    for row, geo in zip(rows, results):
        cc = geo.get('cc')
        admin1 = geo.get('admin1')
        if cc == 'US' and admin1:
            loc = admin1  # e.g. "Texas"
        else:
            loc = COUNTRY_NAMES.get(cc, cc)
        conn.execute("UPDATE activities SET location=? WHERE id=?",
                     (loc, row[0]))


def counts():
    conn = connect()
    try:
        acts = conn.execute(
            "SELECT COUNT(*) FROM activities WHERE deleted_from_strava=0"
        ).fetchone()[0]
        with_points = conn.execute(
            "SELECT COUNT(*) FROM activities "
            "WHERE has_points=1 AND deleted_from_strava=0"
        ).fetchone()[0]
        points = conn.execute("SELECT COUNT(*) FROM track_points").fetchone()[0]
        deleted = conn.execute(
            "SELECT COUNT(*) FROM activities WHERE deleted_from_strava=1"
        ).fetchone()[0]
        return {
            "activities":              acts,
            "activities_with_points":  with_points,
            "track_points":            points,
            "deleted_from_strava":     deleted,
        }
    finally:
        conn.close()


def last_ingest():
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM ingest_runs WHERE status='done' "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()
