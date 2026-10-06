import { describe, expect, it } from "vitest";
import { mslFtToEllipsoidM } from "./altitude";
import type { GeoidGrid } from "./geoid";
import { parseMetars } from "./metar";
import type { TrackFile, TrackSample } from "./track";
import { checkLanding, residualsM, summarize } from "./validation";

const N = -32;
const flatGeoid: GeoidGrid = { latMin: 37, latMax: 38, lonMin: -123, lonMax: -122, step: 1, values: [[N, N], [N, N]] };
const metars = parseMetars([{ obsTime: 0, rawOb: "METAR KSFO 010000Z 29010KT 10SM 15/10 A3012" }]);

const sample = (tMs: number, altBaroFt: TrackSample["altBaroFt"], altGeomFt: number | null): TrackSample => ({
  tMs,
  lat: 37.6,
  lon: -122.4,
  altBaroFt,
  altGeomFt,
  gsKt: 140,
  trackDeg: 280,
  baroRateFpm: -700,
});

describe("summarize", () => {
  it("reports signed median and absolute p95/max", () => {
    expect(summarize([-4, 1, 2, 3])).toEqual({ count: 4, medianM: 1.5, p95AbsM: 4, maxAbsM: 4 });
  });

  it("returns null for no values", () => {
    expect(summarize([])).toBeNull();
  });
});

describe("checkLanding", () => {
  // At 30.12 inHg, 13 ft MSL reads -187 ft pressure altitude. Geom reports HAE: 13 ft MSL + N.
  const geomHaeFt = (13 * 0.3048 + N) / 0.3048;
  const track: TrackFile = {
    id: "abc123",
    hex: "abc123",
    landing: { method: "ground", touchdownMs: 10_000, lastAirborneIndex: 1 },
    samples: [sample(0, 313, geomHaeFt + 500), sample(5_000, -187, geomHaeFt), sample(10_000, "ground", null)],
  };

  it("puts a perfectly reporting aircraft at field elevation for corrected baro and HAE geom", () => {
    const check = checkLanding(track, flatGeoid, metars)!;
    const residuals = residualsM(check, mslFtToEllipsoidM(13, N));
    expect(check.sampleAgeS).toBe(5);
    expect(residuals["baro-corrected"]).toBeCloseTo(0);
    expect(residuals["geom-HAE"]).toBeCloseTo(0);
    expect(residuals["geom-MSL"]).toBeCloseTo(N);
    expect(residuals["baro-uncorrected"]).toBeCloseTo(-200 * 0.3048);
  });

  it("reports a near-ground geom/baro delta of about 0 for an HAE reporter", () => {
    expect(checkLanding(track, flatGeoid, metars)!.deltaGeomHaeMinusBaroM).toBeCloseTo(0);
  });

  it("returns null for a flight with no landing", () => {
    expect(checkLanding({ ...track, landing: null }, flatGeoid, metars)).toBeNull();
  });
});
