// Touchdown altitude checks shared by scripts/validate-landings.ts (against field elevation)
// and the browser validation panel (against sampled terrain).

import { baroToEllipsoidM, geomToEllipsoidM, metersToFeet, uncorrectedBaroToEllipsoidM } from "./altitude";
import { geoidUndulationM, type GeoidGrid } from "./geoid";
import { type Metar, metarAt } from "./metar";
import type { TrackFile, TrackSample } from "./track";

export const KSFO_FIELD_ELEVATION_FT = 13;
// Samples below this corrected-baro MSL altitude count as near-ground for the geom/baro delta.
// Low enough that baro temperature error (which grows with height above the station) is small.
const NEAR_GROUND_MSL_FT = 1000;

export const SOURCES = ["baro-uncorrected", "baro-corrected", "geom-HAE", "geom-MSL"] as const;
export type CheckSource = (typeof SOURCES)[number];

export interface LandingCheck {
  id: string;
  flight?: string;
  lastAirborne: TrackSample;
  touchdown: TrackSample;
  sampleAgeS: number; // touchdown time minus last airborne sample time
  geoidN: number;
  altimeterInHg: number;
  heightsM: Partial<Record<CheckSource, number>>; // last airborne sample, as ellipsoid heights
  // Median of geom (read as HAE) minus corrected baro over near-ground samples.
  // About 0 if the aircraft reports HAE, about -N (+32 m at SFO) if it reports MSL.
  deltaGeomHaeMinusBaroM: number | null;
}

export interface Summary {
  count: number;
  medianM: number; // signed: positive means computed height is above the reference
  p95AbsM: number;
  maxAbsM: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile, p in [0, 100]. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarize(residualsM: number[]): Summary | null {
  if (!residualsM.length) return null;
  const abs = residualsM.map(Math.abs);
  return {
    count: residualsM.length,
    medianM: median(residualsM),
    p95AbsM: percentile(abs, 95),
    maxAbsM: Math.max(...abs),
  };
}

/** Heights for the last airborne sample before touchdown, or null if the flight did not land. */
export function checkLanding(track: TrackFile, geoid: GeoidGrid, metars: Metar[]): LandingCheck | null {
  const landing = track.landing;
  if (!landing) return null;
  const s = track.samples[landing.lastAirborneIndex];
  const touchdown = track.samples[landing.lastAirborneIndex + 1] ?? s;
  const geoidN = geoidUndulationM(geoid, s.lat, s.lon);
  const { altimeterInHg } = metarAt(metars, s.tMs);

  const heightsM: LandingCheck["heightsM"] = {};
  if (typeof s.altBaroFt === "number") {
    heightsM["baro-uncorrected"] = uncorrectedBaroToEllipsoidM(s.altBaroFt, geoidN);
    heightsM["baro-corrected"] = baroToEllipsoidM(s.altBaroFt, altimeterInHg, geoidN);
  }
  if (s.altGeomFt !== null) {
    heightsM["geom-HAE"] = geomToEllipsoidM(s.altGeomFt, "HAE", geoidN);
    heightsM["geom-MSL"] = geomToEllipsoidM(s.altGeomFt, "MSL", geoidN);
  }

  const deltas: number[] = [];
  for (const t of track.samples.slice(0, landing.lastAirborneIndex + 1)) {
    if (typeof t.altBaroFt !== "number" || t.altGeomFt === null) continue;
    const n = geoidUndulationM(geoid, t.lat, t.lon);
    const baroM = baroToEllipsoidM(t.altBaroFt, metarAt(metars, t.tMs).altimeterInHg, n);
    if (metersToFeet(baroM - n) > NEAR_GROUND_MSL_FT) continue;
    deltas.push(geomToEllipsoidM(t.altGeomFt, "HAE", n) - baroM);
  }

  return {
    id: track.id,
    flight: track.flight,
    lastAirborne: s,
    touchdown,
    sampleAgeS: (landing.touchdownMs - s.tMs) / 1000,
    geoidN,
    altimeterInHg,
    heightsM,
    deltaGeomHaeMinusBaroM: deltas.length ? median(deltas) : null,
  };
}

/** Computed height minus reference height for each source available on this landing. */
export function residualsM(check: LandingCheck, referenceHeightM: number): Partial<Record<CheckSource, number>> {
  const out: Partial<Record<CheckSource, number>> = {};
  for (const source of SOURCES) {
    const h = check.heightsM[source];
    if (h !== undefined) out[source] = h - referenceHeightM;
  }
  return out;
}

/** Residual summary per source across many landings. */
export function summarizeBySource(
  perLanding: Partial<Record<CheckSource, number>>[],
): Record<CheckSource, Summary | null> {
  const out = {} as Record<CheckSource, Summary | null>;
  for (const source of SOURCES) {
    out[source] = summarize(perLanding.map((r) => r[source]).filter((v): v is number => v !== undefined));
  }
  return out;
}
