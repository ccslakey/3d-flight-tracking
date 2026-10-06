// Checks the altitude math: for every detected SFO landing, compares the last airborne
// sample's computed height to KSFO field elevation as ellipsoid height.
// Usage: tsx scripts/validate-landings.ts [stamp]   (defaults to the newest recording)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metersToFeet, mslFtToEllipsoidM } from "../src/altitude";
import type { GeoidGrid } from "../src/geoid";
import { parseMetars, type RawMetar } from "../src/metar";
import type { RecordingIndex, TrackFile, TrackManifest } from "../src/track";
import {
  checkLanding,
  KSFO_FIELD_ELEVATION_FT,
  type LandingCheck,
  residualsM,
  SOURCES,
  summarize,
  summarizeBySource,
} from "../src/validation";

const DATA = join("public", "data");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const manifest = readJson<TrackManifest>(join(DATA, "tracks", "manifest.json"));
const recording = process.argv[2]
  ? manifest.recordings.find((r) => r.stamp === process.argv[2])
  : manifest.recordings[manifest.recordings.length - 1];
if (!recording) throw new Error(`Recording ${process.argv[2]} not found in manifest`);

const index = readJson<RecordingIndex>(join(DATA, "tracks", recording.stamp, "index.json"));
const metars = parseMetars(readJson<RawMetar[]>(join(DATA, recording.metarFile)));
const geoid = readJson<GeoidGrid>(join(DATA, "geoid-grid.json"));

const checks: { method: "ground" | "fallback"; check: LandingCheck }[] = [];
for (const flight of index.flights) {
  if (!flight.landing) continue;
  const track = readJson<TrackFile>(join(DATA, "tracks", recording.stamp, `${flight.id}.json`));
  const check = checkLanding(track, geoid, metars);
  if (check) checks.push({ method: flight.landing.method, check });
}

// Fallback landings have no "ground" message, so their touchdown time is too loose for residuals.
const groundChecks = checks.filter((c) => c.method === "ground").map((c) => c.check);
const perLanding = groundChecks.map((c) => residualsM(c, mslFtToEllipsoidM(KSFO_FIELD_ELEVATION_FT, c.geoidN)));
const bySource = summarizeBySource(perLanding);

const fmt = (m: number) => `${m >= 0 ? "+" : ""}${m.toFixed(1)} m (${m >= 0 ? "+" : ""}${metersToFeet(m).toFixed(0)} ft)`;
const fmtAbs = (m: number) => `${m.toFixed(1)} m (${metersToFeet(m).toFixed(0)} ft)`;

console.log(`Recording ${recording.stamp}: ${groundChecks.length} landings with "ground" (${checks.length - groundChecks.length} fallback-only, excluded)`);
const altimeters = metars.map((m) => m.altimeterInHg);
console.log(`Altimeter during window: ${Math.min(...altimeters).toFixed(2)} to ${Math.max(...altimeters).toFixed(2)} inHg`);
const age = summarize(groundChecks.map((c) => c.sampleAgeS));
if (age) console.log(`Last airborne sample age before touchdown: median ${age.medianM.toFixed(1)} s, max ${age.maxAbsM.toFixed(1)} s`);

console.log(`\nResidual vs KSFO field elevation (${KSFO_FIELD_ELEVATION_FT} ft MSL), computed minus reference:`);
console.table(
  Object.fromEntries(
    SOURCES.map((source) => {
      const s = bySource[source];
      return [
        source,
        s
          ? { count: s.count, median: fmt(s.medianM), "p95 |res|": fmtAbs(s.p95AbsM), "max |res|": fmtAbs(s.maxAbsM) }
          : { count: 0 },
      ];
    }),
  ),
);

// Geom reference per landing: whichever reading puts the last airborne sample closer to the
// runway. This beats the geom/baro delta, which also absorbs baro's own near-ground error.
const geomLandings = perLanding.filter((r) => r["geom-HAE"] !== undefined);
const closerAsHae = geomLandings.filter((r) => Math.abs(r["geom-HAE"]!) < Math.abs(r["geom-MSL"]!)).length;
console.log(`\nGeom reference: ${closerAsHae} of ${geomLandings.length} landings sit closer to the runway read as HAE, ${geomLandings.length - closerAsHae} as MSL`);

const deltas = groundChecks.map((c) => c.deltaGeomHaeMinusBaroM).filter((d): d is number => d !== null);
const deltaSummary = summarize(deltas);
if (deltaSummary) {
  const meanN = groundChecks.reduce((sum, c) => sum + c.geoidN, 0) / groundChecks.length;
  console.log(`Near-ground geom (as HAE) minus corrected baro, per-aircraft medians (HAE ≈ 0, MSL ≈ ${(-meanN).toFixed(0)} m, before baro error):`);
  console.log(`  ${deltas.length} aircraft, median ${fmt(deltaSummary.medianM)}`);
  console.log(`  values: ${[...deltas].sort((a, b) => a - b).map((d) => d.toFixed(1)).join(", ")}`);
}

const outPath = join(DATA, `validation-${recording.stamp}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      recording: recording.stamp,
      bySource,
      geomReference: { closerAsHae, landingsWithGeom: geomLandings.length, deltaSummary },
      landings: groundChecks.map((c, i) => ({ ...c, residualsM: perLanding[i] })),
    },
    null,
    1,
  ),
);
console.log(`\nWrote ${outPath}`);
