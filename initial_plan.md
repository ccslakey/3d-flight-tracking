# Flight Replay PoC: 3D Cesium Map with Correct Altitudes

## Goal

Build a vanilla TypeScript + CesiumJS proof of concept that replays recorded ADS-B traffic around SFO on a 3D terrain globe, with aircraft altitudes converted correctly into Cesium's reference frame and a measurable check that proves the conversion is right.

The core of this project is altitude correctness. Rendering is secondary. Every altitude shown on the globe must come from one tested module, and the validation step must report how far computed touchdown heights are from the runway.

## Constraints

- No React or other UI framework. Plain TypeScript and DOM.
- Vite + TypeScript + CesiumJS. Serve Cesium's static assets with `vite-plugin-static-copy` and `CESIUM_BASE_URL` (Cesium's documented Vite setup), not `vite-plugin-cesium`, which lags current Vite releases.
- Node scripts are TypeScript, run with `tsx`. `build-geoid-grid.py` needs Python 3 and `pyproj`; document both in the README.
- Vitest for unit tests.
- Cesium ion token comes from `VITE_CESIUM_ION_TOKEN` in `.env`. Never commit `.env`.
- Initialize git with a `.gitignore` covering `.env`, `node_modules`, and raw recordings (`public/data/raw/`).
- Data is recorded by Node scripts and served as static files. The browser does not call adsb.lol or aviationweather.gov directly.
- Check the installed Cesium version's API before writing Cesium code. Do not assume older patterns (for example, prefer `Terrain.fromWorldTerrain()` if the installed version supports it).
- Stop at each **Checkpoint** below and report results before continuing.

## Background: the altitude problem

Cesium positions (`Cartesian3.fromDegrees(lon, lat, h)`) take `h` in meters above the WGS84 ellipsoid. Cesium World Terrain is also ellipsoid-referenced. ADS-B altitudes are in feet and use other references:

| ADS-B field          | Meaning                                                                                            | Conversion to ellipsoid height                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `alt_baro` (number)  | Pressure altitude, referenced to standard pressure 29.92 inHg                                      | Correct with the METAR altimeter setting to get MSL, convert to meters, add geoid undulation N |
| `alt_geom`           | GNSS altitude. readsb documents it as WGS84 ellipsoid-referenced, but some aircraft may report MSL | Convert to meters. Reference (HAE vs MSL) is a config flag until Phase 6 settles it            |
| `alt_baro: "ground"` | On the ground, no altitude                                                                         | Clamp to sampled terrain height                                                                |

Formulas:

```
msl_ft   = alt_baro + (altimeter_inHg - 29.92) * 1000
height_m = msl_ft * 0.3048 + N
```

N is the geoid undulation (ellipsoid height minus orthometric/MSL height). Around SFO it is roughly -32 m. 1 inHg = 33.8639 hPa.

## Data sources

- **ADS-B (live, used for recording):** adsb.lol public API, no key. `GET https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}`. Aircraft are in the `ac` array, keyed by ICAO hex. Check https://api.adsb.lol/docs for radius units and field names before writing the recorder, and confirm keyless access still works. Data is ODbL-licensed; the README must include attribution.
- **Weather:** aviationweather.gov Data API, no key. `GET https://aviationweather.gov/api/data/metar?ids=KSFO&format=json&hours={n}`. Send a descriptive User-Agent and stay under 100 requests per minute. Verify the units of the altimeter field from a real response before using it. History is limited, so fetch METARs soon after recording.
- **Geoid:** EGM96 via `pyproj` (offline, precomputed into a small grid).
- **Reference values:** SFO center approx 37.6189, -122.3750. KSFO field elevation 13 ft MSL.

## File layout

```
/scripts
  record-adsb.ts         # polls adsb.lol, writes NDJSON snapshots
  record-metar.ts        # pulls KSFO METARs covering the recording window
  extract-tracks.ts      # raw snapshots -> per-flight track files with only needed fields
  build-geoid-grid.py    # precomputes N over a Bay Area bbox into JSON
  validate-landings.ts   # altitude math check against field elevation
/src
  main.ts                # viewer setup, wiring
  altitude.ts            # the conversion module (pure functions)
  geoid.ts               # loads grid, bilinear interpolation
  metar.ts               # parse METARs, pick the one in effect at time t
  replay.ts              # builds entities + SampledPositionProperty from samples
  debugTrails.ts         # raw / corrected / geom trail overlays
  altitude.test.ts
  geoid.test.ts
  metar.test.ts
/public/data
  raw/adsb-*.ndjson      # gitignored, ~70 MB/hour
  tracks/*.json          # per-flight tracks, loaded by the browser
  metar-*.json
  geoid-grid.json
.env                     # VITE_CESIUM_ION_TOKEN (gitignored)
```

## Phases

### Phase 1: Scaffold

- Vite + TS project, CesiumJS installed and building.
- Viewer with World Terrain, camera framed on SFO.
- `scene.globe.depthTestAgainstTerrain = true` so anything rendered below terrain is hidden. This makes altitude errors visible.

**Done when:** `npm run dev` shows SFO on 3D terrain with no console errors.

### Phase 2: Record data

- Before recording, check the current KSFO altimeter setting. Prefer a day at least 0.15 inHg away from 29.92; near 29.92 the baro correction is too small to validate.
- `record-adsb.ts`: poll adsb.lol around SFO every 5 seconds (radius roughly 40 nm), append each snapshot as one NDJSON line with a recorded-at timestamp and the API's `now`. Configurable duration. Back off on 429s.
- `record-metar.ts`: fetch KSFO METARs covering the recording window plus at least one hour before it, so every sample has a METAR at or before it. Save as JSON.
- `extract-tracks.ts`: build per-flight tracks. Each sample's timestamp is the snapshot's `now` minus `seen_pos` (position) or `seen` (other fields), not the recorded-at time. Drop samples whose timestamp repeats the previous one for that aircraft (stale data carried across polls). Keep only the fields the app needs.
- Landing detection: an aircraft whose `alt_baro` goes from numeric to `"ground"` near SFO. Some aircraft never report `"ground"`, so also flag arrivals that reach low altitude and low ground speed near the runways, and count them separately.

**Done when:** at least one hour of snapshots and matching METARs are saved in `/public/data`.

**Checkpoint:** report snapshot count, raw data size, number of distinct aircraft, number of detected landings (with `"ground"` vs. fallback-only counts), the altimeter range during the window, and a sample raw METAR with the parsed altimeter value and units.

### Phase 3: Geoid grid

- `build-geoid-grid.py`: use `pyproj` to compute N over a bbox that covers the full 40 nm recording radius plus margin (roughly 36.8 to 38.5 N, -123.4 to -121.3 W) at about 0.05 degree spacing. Enable the PROJ network or download the EGM96 grid so the transform is real, not a no-op.
- Write `{ latMin, latMax, lonMin, lonMax, step, values[][] }` to `geoid-grid.json`.
- The script must assert that N at SFO is between -35 and -29 m. If it is near 0, the geoid grid was not loaded.
- `geoid.ts`: load the grid and bilinear-interpolate. Throw outside the bbox.

**Done when:** `geoid.test.ts` passes, including the SFO range check.

### Phase 4: Altitude module

`altitude.ts` exports a pure function:

```ts
type AltSource = "geom" | "baro-corrected" | "ground";

interface AltResult {
  heightM: number | null;      // null for ground until terrain is sampled
  source: AltSource;
  deltaGeomBaroM?: number;     // geom minus corrected baro, when both exist
}

toEllipsoidHeight(sample, ctx): AltResult
// ctx: { altimeterInHg: number, geoidN: number, geomReference: "HAE" | "MSL" }
```

Rules:

- `alt_baro === "ground"` returns `source: "ground"`. Ground clamping happens in the render layer via `sampleTerrainMostDetailed`.
- Until Phase 6 settles `geomReference`, prefer corrected `alt_baro`; use `alt_geom` (applying N only when `geomReference === "MSL"`) only when baro is missing. After Phase 6, revisit whether geom should take priority.
- Always compute `deltaGeomBaroM` when both are present, with both values already converted to ellipsoid height.
- `metar.ts` picks the latest METAR at or before each sample's timestamp, not the latest overall.

**Done when:** unit tests cover each source path, the MSL/HAE flag, the 29.92 baseline (no correction), a high and a low pressure day, and METAR selection by timestamp.

### Phase 5: Render one landing

- Pick one recorded SFO arrival.
- Render it as an entity with a `SampledPositionProperty` driven by `altitude.ts`, synced to the Cesium clock and timeline.
- `debugTrails.ts`: toggle three polylines for the same flight: uncorrected baro, corrected baro, geom. Distinct colors and a small legend.

**Done when:** scrubbing the timeline moves the aircraft smoothly to touchdown, and the three trails are visible and toggleable.

### Phase 6: Validate

- `validate-landings.ts`: for every detected landing, take the last airborne sample before the first `"ground"` message and compare computed height to KSFO field elevation converted to ellipsoid height (`13 * 0.3048 + N`). Report per source: count, median residual, p95, max, and the age of that sample relative to the first `"ground"` message.
- Expect a positive residual bias: the last airborne sample can be several seconds before touchdown (about 50 to 60 ft of descent at 5 s), and the GNSS antenna sits above the wheels.
- Decide `geomReference` from `deltaGeomBaroM` on near-ground samples, not from absolute residuals. Timing bias affects baro and geom equally, so it cancels in the delta.
- In the browser, add a debug panel that does the same comparison against `sampleTerrainMostDetailed` at the touchdown point (this checks rendering, while the script checks the math).

**Expected:** corrected baro and geom land within tens of feet of the runway, after accounting for the timing bias. Uncorrected baro is off by roughly `(altimeter - 29.92) * 1000` ft. Near the ground, `deltaGeomBaroM` near 0 means geom is HAE; near +32 m means that aircraft reports MSL.

**Checkpoint:** report the residual table and a recommendation for the `geomReference` default.

## Known limits (document in README, do not solve)

- Baro correction ignores temperature error, which grows with height above the station.
- `alt_baro` has 25 ft resolution.
- Terrain mesh resolution makes the runway surface approximate.
- One METAR station for the whole area.
- 5 s polling and data age put the last airborne sample several seconds before touchdown.

## Conventions

- Altitude conversion lives only in `altitude.ts`. No ad hoc unit math in rendering code.
- Units in variable names (`altFt`, `heightM`, `altimeterInHg`).
- README notes that the project was built with an AI coding agent.
