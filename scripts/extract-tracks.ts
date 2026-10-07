// Turns raw adsb.lol snapshots into per-flight track files and detects SFO landings.
// Usage: tsx scripts/extract-tracks.ts public/data/raw/adsb-<stamp>.ndjson
//
// Output: public/data/tracks/<stamp>/index.json, one <flightId>.json per flight, and an
// entry in public/data/tracks/manifest.json.
// Altitudes stay raw (feet, as reported); conversion happens only in src/altitude.ts.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Ingester, type Snapshot } from "../src/ingest";
import type { FlightSummary, Landing, RecordingIndex, TrackFile, TrackManifest, TrackSample } from "../src/track";

const SFO_LAT = 37.6189;
const SFO_LON = -122.375;
const LANDING_RADIUS_NM = 2; // covers all four SFO runways
const FALLBACK_GS_KT = 60; // below this near SFO after being airborne counts as landed

function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return (2 * 6371.0088 * Math.asin(Math.sqrt(a))) / 1.852;
}

const nearSfo = (s: TrackSample) => distanceNm(s.lat, s.lon, SFO_LAT, SFO_LON) <= LANDING_RADIUS_NM;

function detectLanding(samples: TrackSample[]): Landing | null {
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const prev = samples[i - 1];
    if (s.altBaroFt === "ground" && typeof prev.altBaroFt === "number" && nearSfo(s)) {
      return { method: "ground", touchdownMs: s.tMs, lastAirborneIndex: i - 1 };
    }
  }
  // Fallback for aircraft that never report "ground": airborne, then slow near SFO.
  if (samples.some((s) => s.altBaroFt === "ground")) return null;
  let lastAirborne = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (typeof s.altBaroFt === "number" && (s.gsKt ?? 0) >= FALLBACK_GS_KT) lastAirborne = i;
    if (lastAirborne >= 0 && i > lastAirborne && nearSfo(s) && s.gsKt !== null && s.gsKt < FALLBACK_GS_KT) {
      return { method: "fallback", touchdownMs: s.tMs, lastAirborneIndex: lastAirborne };
    }
  }
  return null;
}

const rawPath = process.argv[2];
if (!rawPath) throw new Error("Usage: tsx scripts/extract-tracks.ts <adsb ndjson>");

const stamp = basename(rawPath).replace(/^adsb-/, "").replace(/\.ndjson$/, "");
const ingester = new Ingester();
let snapshotCount = 0;

for (const line of readFileSync(rawPath, "utf8").split("\n")) {
  if (!line) continue;
  ingester.ingest(JSON.parse(line) as Snapshot);
  snapshotCount++;
}

const outDir = join("public", "data", "tracks", stamp);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const flights: FlightSummary[] = [];
for (const { id, hex, flight, typeCode, samples } of ingester.flights.values()) {
  const landing = detectLanding(samples);
  const file: TrackFile = { id, hex, flight, typeCode, landing, samples };
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(file));
  flights.push({
    id,
    hex,
    flight,
    typeCode,
    sampleCount: samples.length,
    startMs: samples[0].tMs,
    endMs: samples[samples.length - 1].tMs,
    hasGeom: samples.some((s) => s.altGeomFt !== null),
    landing,
  });
}

const landings = flights.filter((f) => f.landing);
const summary = {
  source: basename(rawPath),
  snapshotCount,
  rawBytes: statSync(rawPath).size,
  distinctAircraft: new Set(flights.map((f) => f.hex)).size,
  flightCount: flights.length,
  droppedStale: ingester.droppedStale,
  droppedDuplicate: ingester.droppedDuplicate,
  landings: {
    ground: landings.filter((f) => f.landing!.method === "ground").length,
    fallback: landings.filter((f) => f.landing!.method === "fallback").length,
  },
};
const index: RecordingIndex = { ...summary, flights };
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 1));

const manifestPath = join("public", "data", "tracks", "manifest.json");
const manifest: TrackManifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { recordings: [] };
manifest.recordings = manifest.recordings.filter((r) => r.stamp !== stamp);
manifest.recordings.push({ stamp, metarFile: `metar-${stamp}.json` });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(JSON.stringify(summary, null, 2));
