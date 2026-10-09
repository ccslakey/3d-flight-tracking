import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FLIGHT_GAP_MS, type RawAircraft } from "../src/ingest";
import type { RawMetar } from "../src/metar";
import { Archive } from "./archive";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ac = (hex: string, over: Partial<RawAircraft> = {}): RawAircraft => ({
  hex,
  lat: 37.6,
  lon: -122.4,
  alt_baro: 3000,
  seen_pos: 0,
  ...over,
});
const metar = (obsTimeMs: number): RawMetar => ({ obsTime: obsTimeMs / 1000, rawOb: `KSFO A2992 ${obsTimeMs}` });

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-test-"));
  dirs.push(dir);
  return join(dir, "archive.sqlite");
};

describe("Archive", () => {
  it("returns whole flights that have samples in the window, and omits the rest", () => {
    const archive = new Archive(":memory:", DAY);
    archive.ingest({ now: 1_000, ac: [ac("aaa111")] });
    archive.ingest({ now: 6_000, ac: [ac("aaa111"), ac("bbb222")] });
    archive.ingest({ now: 11_000, ac: [ac("aaa111")] });
    archive.ingest({ now: 20_000, ac: [ac("ccc333")] });
    const h = archive.history(5_000, 7_000);
    expect(h.flights.map((f) => [f.id, f.samples.map((s) => s.tMs)])).toEqual([
      ["aaa111", [1_000, 6_000, 11_000]],
      ["bbb222", [6_000]],
    ]);
  });

  it("round-trips sample fields, including ground and missing values", () => {
    const archive = new Archive(":memory:", DAY);
    archive.ingest({
      now: 1_000,
      ac: [ac("aaa111", { alt_baro: "ground", alt_geom: undefined, gs: 12.5, track: 90, true_heading: 88, flight: "UAL1  ", t: "A320" })],
    });
    const [f] = archive.history(0, 2_000).flights;
    expect(f).toMatchObject({ id: "aaa111", flight: "UAL1", typeCode: "A320" });
    expect(f.samples[0]).toEqual({
      tMs: 1_000,
      lat: 37.6,
      lon: -122.4,
      altBaroFt: "ground",
      altGeomFt: null,
      gsKt: 12.5,
      trackDeg: 90,
      trueHeadingDeg: 88,
      baroRateFpm: null,
    });
  });

  it("includes the METAR in effect at the window start", () => {
    const archive = new Archive(":memory:", DAY);
    archive.addMetars([metar(0), metar(HOUR), metar(2 * HOUR), metar(3 * HOUR)]);
    const times = archive.history(1.5 * HOUR, 2.5 * HOUR).metars.map((m) => m.obsTime * 1000);
    expect(times).toEqual([HOUR, 2 * HOUR]);
  });

  it("ignores METARs it already holds", () => {
    const archive = new Archive(":memory:", DAY);
    archive.addMetars([metar(0)]);
    expect(archive.addMetars([metar(0), metar(HOUR), metar(HOUR)])).toEqual([metar(HOUR)]);
    expect(archive.counts().metars).toBe(2);
    expect(archive.latestMetarMs()).toBe(HOUR);
  });

  it("finishes flights after the gap, storing their landing and keeping their ID taken", () => {
    const archive = new Archive(":memory:", DAY);
    // Airborne, then on the ground at SFO.
    archive.ingest({ now: 0, ac: [ac("aaa111", { lat: 37.62, lon: -122.37, alt_baro: 200 })] });
    archive.ingest({ now: 5_000, ac: [ac("aaa111", { lat: 37.62, lon: -122.37, alt_baro: "ground" })] });
    expect(archive.finishFlights(FLIGHT_GAP_MS)).toBe(0);
    expect(archive.finishFlights(2 * FLIGHT_GAP_MS)).toBe(1);
    expect(archive.counts().activeFlights).toBe(0);
    expect(archive.history(0, 10_000).flights[0].landing).toEqual({ method: "ground", touchdownMs: 5_000, lastAirborneIndex: 0 });

    archive.ingest({ now: 3 * FLIGHT_GAP_MS, ac: [ac("aaa111")] });
    expect(archive.history(0, 4 * FLIGHT_GAP_MS).flights.map((f) => f.id)).toEqual(["aaa111", "aaa111-1"]);
  });

  it("detects landings on flights that are still active", () => {
    const archive = new Archive(":memory:", DAY);
    archive.ingest({ now: 0, ac: [ac("aaa111", { lat: 37.62, lon: -122.37, alt_baro: 200 })] });
    archive.ingest({ now: 5_000, ac: [ac("aaa111", { lat: 37.62, lon: -122.37, alt_baro: "ground" })] });
    expect(archive.history(0, 10_000).flights[0].landing?.method).toBe("ground");
  });

  it("counts flights and landings per hour of flight start", () => {
    const archive = new Archive(":memory:", DAY);
    archive.ingest({ now: 0.2 * HOUR, ac: [ac("aaa111"), ac("bbb222")] });
    archive.ingest({ now: 1.5 * HOUR, ac: [ac("ccc333")] });
    expect(archive.hours()).toEqual([
      { startMs: 0, flights: 2, landings: 0 },
      { startMs: HOUR, flights: 1, landings: 0 },
    ]);
    expect(archive.startMs()).toBe(0.2 * HOUR);
  });

  it("prunes flights that ended before retention, frees their IDs, and drops METARs no longer in effect", () => {
    const archive = new Archive(":memory:", HOUR);
    archive.addMetars([metar(0), metar(0.5 * HOUR), metar(1.5 * HOUR)]);
    archive.ingest({ now: 0, ac: [ac("aaa111"), ac("bbb222")] });
    archive.ingest({ now: 1.2 * HOUR, ac: [ac("aaa111")] }); // gaps over 10 min split flights: aaa111-1
    archive.finishFlights(2 * HOUR);
    expect(archive.prune(2 * HOUR)).toBe(2);
    archive.ingest({ now: 2 * HOUR, ac: [ac("bbb222")] });
    const h = archive.history(0, 3 * HOUR);
    expect(h.flights.map((f) => f.id).sort()).toEqual(["aaa111-1", "bbb222"]);
    expect(h.metars.map((m) => m.obsTime * 1000)).toEqual([0.5 * HOUR, 1.5 * HOUR]);
  });

  it("restores active flights after a restart so they keep growing under their IDs", () => {
    const path = tempPath();
    const first = new Archive(path, DAY);
    first.ingest({ now: 0, ac: [ac("aaa111", { flight: "UAL1" })] });
    first.ingest({ now: 5_000, ac: [ac("bbb222")] });
    first.finishFlights(FLIGHT_GAP_MS + 20_000); // aaa111 finishes, bbb222 is still active
    first.close();

    const second = new Archive(path, DAY);
    expect(second.counts()).toMatchObject({ flights: 2, activeFlights: 1 });
    second.ingest({ now: 10_000, ac: [ac("bbb222")] });
    second.ingest({ now: FLIGHT_GAP_MS + 30_000, ac: [ac("aaa111")] });
    const h = second.history(0, 2 * FLIGHT_GAP_MS);
    expect(h.flights.map((f) => [f.id, f.flight, f.samples.length])).toEqual([
      ["aaa111", "UAL1", 1],
      ["bbb222", undefined, 2],
      ["aaa111-1", undefined, 1],
    ]);
    second.close();
  });
});
