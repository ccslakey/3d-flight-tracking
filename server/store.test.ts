import { describe, expect, it } from "vitest";
import type { RawAircraft } from "../src/ingest";
import type { RawMetar } from "../src/metar";
import { LiveStore } from "./store";

const HOUR = 3_600_000;
const ac = (hex: string): RawAircraft => ({ hex, lat: 37.6, lon: -122.4, alt_baro: 3000, seen_pos: 0 });
const metar = (obsTimeMs: number): RawMetar => ({ obsTime: obsTimeMs / 1000, rawOb: `KSFO A2992 ${obsTimeMs}` });

describe("LiveStore", () => {
  it("returns only samples inside the window and omits flights with none", () => {
    const store = new LiveStore(4 * HOUR);
    store.ingest({ now: 1_000, ac: [ac("aaa111")] });
    store.ingest({ now: 6_000, ac: [ac("aaa111"), ac("bbb222")] });
    store.ingest({ now: 11_000, ac: [ac("aaa111")] });
    const h = store.history(5_000, 7_000);
    expect(h.flights.map((f) => [f.id, f.samples.map((s) => s.tMs)])).toEqual([
      ["aaa111", [6_000]],
      ["bbb222", [6_000]],
    ]);
    expect(h.flights[0].landing).toBeNull();
  });

  it("includes the METAR in effect at the window start", () => {
    const store = new LiveStore(4 * HOUR, { metars: [metar(0), metar(HOUR), metar(2 * HOUR), metar(3 * HOUR)] });
    const times = store.history(1.5 * HOUR, 2.5 * HOUR).metars.map((m) => m.obsTime * 1000);
    expect(times).toEqual([HOUR, 2 * HOUR]);
  });

  it("ignores METARs it already holds", () => {
    const store = new LiveStore(4 * HOUR, { metars: [metar(0)] });
    expect(store.addMetars([metar(0), metar(HOUR), metar(HOUR)])).toEqual([metar(HOUR)]);
    expect(store.counts().metars).toBe(2);
  });

  it("prunes old samples, empty flights, and METARs no longer in effect", () => {
    const store = new LiveStore(HOUR, { metars: [metar(0), metar(0.5 * HOUR), metar(1.5 * HOUR)] });
    store.ingest({ now: 0, ac: [ac("aaa111"), ac("bbb222")] });
    store.ingest({ now: 0.9 * HOUR, ac: [ac("aaa111")] });
    store.ingest({ now: 1.6 * HOUR, ac: [ac("aaa111")] });
    store.prune(2 * HOUR);
    const h = store.history(0, 3 * HOUR);
    expect(h.flights.map((f) => [f.id, f.samples.map((s) => s.tMs)])).toEqual([["aaa111-2", [1.6 * HOUR]]]); // gaps over 10 min split flights
    expect(h.metars.map((m) => m.obsTime * 1000)).toEqual([0.5 * HOUR, 1.5 * HOUR]);
  });

  it("frees a pruned flight's ID", () => {
    const store = new LiveStore(HOUR);
    store.ingest({ now: 0, ac: [ac("aaa111")] });
    store.prune(2 * HOUR);
    store.ingest({ now: 2 * HOUR, ac: [ac("aaa111")] });
    expect(store.history(0, 3 * HOUR).flights.map((f) => f.id)).toEqual(["aaa111"]);
  });

  it("continues restored flights under their IDs", () => {
    const sample = { tMs: 0, lat: 37.6, lon: -122.4, altBaroFt: 3000, altGeomFt: null, gsKt: null, trackDeg: null, baroRateFpm: null };
    const store = new LiveStore(HOUR, { flights: [{ id: "aaa111-2", hex: "aaa111", flight: "UAL1", samples: [sample] }] });
    store.ingest({ now: 5_000, ac: [ac("aaa111")] });
    expect(store.history(0, HOUR).flights.map((f) => [f.id, f.flight, f.samples.length])).toEqual([["aaa111-2", "UAL1", 2]]);
  });
});
