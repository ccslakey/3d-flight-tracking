# /// script
# requires-python = ">=3.10"
# dependencies = ["pyproj>=3.6"]
# ///
"""Precompute EGM96 geoid undulation N (ellipsoid height minus MSL height) over the
Bay Area and write public/data/geoid-grid.json.

Usage: uv run scripts/build-geoid-grid.py
"""

import json
from pathlib import Path

import pyproj
from pyproj import Transformer

LAT_MIN, LAT_MAX = 36.8, 38.5
LON_MIN, LON_MAX = -123.4, -121.3
STEP = 0.05
SFO_LAT, SFO_LON = 37.6189, -122.375
OUT = Path("public/data/geoid-grid.json")

# Fetch the EGM96 grid from the PROJ CDN on demand. Without it, the transform
# silently falls back to a no-op and N comes out as 0.
pyproj.network.set_network_enabled(True)

# From WGS84 + EGM96 height (EPSG:4326+5773) to WGS84 3D (EPSG:4979).
# An MSL height of 0 maps to an ellipsoid height of exactly N.
# only_best raises instead of falling back to a ballpark (no-grid) transform.
transformer = Transformer.from_crs("EPSG:4326+5773", "EPSG:4979", always_xy=True, only_best=True)


def undulation_m(lat: float, lon: float) -> float:
    _, _, h = transformer.transform(lon, lat, 0.0)
    return h


n_sfo = undulation_m(SFO_LAT, SFO_LON)
print(f"N at SFO: {n_sfo:.3f} m")
assert -35 <= n_sfo <= -29, f"N at SFO is {n_sfo:.3f} m; expected -35 to -29. Geoid grid not loaded?"

n_lat = round((LAT_MAX - LAT_MIN) / STEP) + 1
n_lon = round((LON_MAX - LON_MIN) / STEP) + 1
values = [
    [round(undulation_m(LAT_MIN + i * STEP, LON_MIN + j * STEP), 3) for j in range(n_lon)]
    for i in range(n_lat)
]

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({
    "model": "EGM96",
    "latMin": LAT_MIN,
    "latMax": LAT_MAX,
    "lonMin": LON_MIN,
    "lonMax": LON_MAX,
    "step": STEP,
    "values": values,  # values[latIndex][lonIndex], latIndex 0 = latMin
}))
flat = [v for row in values for v in row]
print(f"Wrote {OUT}: {n_lat}x{n_lon} grid, N from {min(flat):.2f} to {max(flat):.2f} m")
