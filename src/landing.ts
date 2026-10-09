// SFO landing detection, shared by scripts/extract-tracks.ts and the relay's archive so
// recordings and archived flights mark landings the same way.

import type { Landing, TrackSample } from "./track";

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

/** The first SFO landing in a flight's time-ordered samples, or null. */
export function detectLanding(samples: TrackSample[]): Landing | null {
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
