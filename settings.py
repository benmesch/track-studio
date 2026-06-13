"""App-wide user settings persisted as a tiny JSON file.

Kept deliberately simple (no DB row, no migration story) — these are
single-user, single-device preferences. Add new keys to _DEFAULTS and
they'll start showing up in GET /api/settings on the next call.
"""

import json
from pathlib import Path

SETTINGS_PATH = Path(__file__).parent / "app_settings.json"

# When a setting isn't in the JSON file, fall back to these. Also defines
# the allow-list for writes — PATCH ignores keys not present here.
_DEFAULTS = {
    "max_hr": 190,
}


def load():
    """Return the current settings, falling back to defaults for missing keys."""
    if not SETTINGS_PATH.exists():
        return dict(_DEFAULTS)
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return dict(_DEFAULTS)
    return {**_DEFAULTS, **{k: data[k] for k in data if k in _DEFAULTS}}


def save(updates):
    """Merge `updates` (a dict) into the stored settings and persist. Keys
    not in _DEFAULTS are silently dropped. Returns the new settings dict."""
    current = load()
    for k, v in updates.items():
        if k in _DEFAULTS:
            current[k] = v
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    return current
