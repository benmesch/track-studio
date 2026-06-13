"""Serialize a stored activity (header dict + track_points list) back to GPX 1.1.

Used by the activity-detail download endpoint, and reused by the local-upload
side of Track Studio when round-tripping user-saved GPX files.
"""

import re
import xml.etree.ElementTree as ET

GPX_NS    = "http://www.topografix.com/GPX/1/1"
GPXTPX_NS = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"

# Registering once at import time gives us clean `xmlns=` / `xmlns:gpxtpx=`
# attributes in the output rather than ElementTree's auto `ns0:` prefixes.
ET.register_namespace("",       GPX_NS)
ET.register_namespace("gpxtpx", GPXTPX_NS)


def _q(local, ns=GPX_NS):
    return f"{{{ns}}}{local}"


def _fmt_num(v):
    """Render a numeric coord/elevation without scientific notation or trailing
    junk. Ints stay ints; floats keep up to 7 decimals (≈1 cm at the equator)."""
    if isinstance(v, int):
        return str(v)
    s = f"{float(v):.7f}".rstrip("0").rstrip(".")
    return s if s else "0"


def write_gpx(activity, points):
    """Return GPX 1.1 bytes for the given activity row + ordered track points.

    activity is a dict with at least name/type/start_time (any may be None).
    points is an iterable of dicts with sequence/time/lat/lon/elevation_m and
    optional hr/cadence/power/temperature_c. Points missing lat or lon are
    skipped — a GPX trkpt without coords is invalid.
    """
    gpx = ET.Element(_q("gpx"), {
        "version": "1.1",
        "creator": "Track Studio",
    })

    meta = ET.SubElement(gpx, _q("metadata"))
    if activity.get("name"):
        ET.SubElement(meta, _q("name")).text = str(activity["name"])
    if activity.get("start_time"):
        ET.SubElement(meta, _q("time")).text = str(activity["start_time"])

    trk = ET.SubElement(gpx, _q("trk"))
    if activity.get("name"):
        ET.SubElement(trk, _q("name")).text = str(activity["name"])
    if activity.get("type"):
        ET.SubElement(trk, _q("type")).text = str(activity["type"])
    seg = ET.SubElement(trk, _q("trkseg"))

    for p in points:
        lat = p.get("lat")
        lon = p.get("lon")
        if lat is None or lon is None:
            continue
        pt = ET.SubElement(seg, _q("trkpt"), {
            "lat": _fmt_num(lat),
            "lon": _fmt_num(lon),
        })
        if p.get("elevation_m") is not None:
            ET.SubElement(pt, _q("ele")).text = _fmt_num(p["elevation_m"])
        if p.get("time"):
            ET.SubElement(pt, _q("time")).text = str(p["time"])

        hr   = p.get("hr")
        cad  = p.get("cadence")
        pwr  = p.get("power")
        temp = p.get("temperature_c")
        if hr or cad or pwr or temp is not None:
            exts = ET.SubElement(pt, _q("extensions"))
            # Garmin Connect convention: bare <power> sibling of TrackPointExt
            if pwr:
                ET.SubElement(exts, _q("power")).text = str(int(pwr))
            if hr or cad or temp is not None:
                tpx = ET.SubElement(exts, _q("TrackPointExtension", GPXTPX_NS))
                if temp is not None:
                    ET.SubElement(tpx, _q("atemp", GPXTPX_NS)).text = _fmt_num(temp)
                if hr:
                    ET.SubElement(tpx, _q("hr", GPXTPX_NS)).text = str(int(hr))
                if cad:
                    ET.SubElement(tpx, _q("cad", GPXTPX_NS)).text = str(int(cad))

    return ET.tostring(gpx, encoding="utf-8", xml_declaration=True)


_BAD_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def gpx_filename(activity):
    """Build a safe download filename for the given activity row."""
    name = (activity.get("name") or "").strip() or "activity"
    safe = _BAD_FILENAME.sub("_", name).strip("_") or "activity"
    aid = activity.get("id")
    return f"{safe}-{aid}.gpx" if aid is not None else f"{safe}.gpx"
