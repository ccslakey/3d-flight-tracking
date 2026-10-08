import { describe, expect, it } from "vitest";
import { assignFlightId, FLIGHT_GAP_MS, Ingester, type RawAircraft } from "./ingest";

const ac = (over: Partial<RawAircraft> = {}): RawAircraft => ({
  hex: "abc123",
  lat: 37.6,
  lon: -122.4,
  alt_baro: 3000,
  seen_pos: 0,
  ...over,
});

describe("assignFlightId", () => {
  it("uses the bare hex when it is free", () => {
    expect(assignFlightId("abc123", new Set())).toBe("abc123");
  });

  it("adds the first free index when the hex is taken", () => {
    expect(assignFlightId("abc123", new Set(["abc123"]))).toBe("abc123-1");
    expect(assignFlightId("abc123", new Set(["abc123", "abc123-1", "abc123-3"]))).toBe("abc123-2");
  });
});

describe("Ingester", () => {
  it("times each sample by the snapshot time minus the position age", () => {
    const ing = new Ingester();
    ing.ingest({ now: 100_000, ac: [ac({ seen_pos: 2.5 })] });
    expect(ing.flights.get("abc123")!.samples[0].tMs).toBe(97_500);
  });

  it("skips aircraft without a position", () => {
    const ing = new Ingester();
    expect(ing.ingest({ now: 0, ac: [ac({ lat: undefined }), ac({ seen_pos: undefined })] })).toEqual([]);
    expect(ing.flights.size).toBe(0);
  });

  it("skips the placeholder position some ground vehicles report", () => {
    const ing = new Ingester();
    expect(ing.ingest({ now: 0, ac: [ac({ lat: 37.5, lon: -122.553191, alt_baro: "ground" })] })).toEqual([]);
    expect(ing.flights.size).toBe(0);
  });

  it("drops stale positions", () => {
    const ing = new Ingester();
    ing.ingest({ now: 100_000, ac: [ac({ seen_pos: 16 })] });
    expect(ing.flights.size).toBe(0);
    expect(ing.droppedStale).toBe(1);
  });

  it("drops a position repeated from the previous poll", () => {
    const ing = new Ingester();
    ing.ingest({ now: 100_000, ac: [ac({ seen_pos: 1 })] });
    const updates = ing.ingest({ now: 105_000, ac: [ac({ seen_pos: 6 })] });
    expect(updates).toEqual([]);
    expect(ing.droppedDuplicate).toBe(1);
    expect(ing.flights.get("abc123")!.samples).toHaveLength(1);
  });

  it("returns only the samples each snapshot added", () => {
    const ing = new Ingester();
    ing.ingest({ now: 100_000, ac: [ac()] });
    const updates = ing.ingest({ now: 105_000, ac: [ac(), ac({ hex: "def456" })] });
    expect(updates.map((u) => [u.flight.id, u.samples.map((s) => s.tMs)])).toEqual([
      ["abc123", [105_000]],
      ["def456", [105_000]],
    ]);
  });

  it("keeps samples in time order when a position arrives late", () => {
    const ing = new Ingester();
    ing.ingest({ now: 100_000, ac: [ac()] });
    ing.ingest({ now: 105_000, ac: [ac({ seen_pos: 7 })] });
    expect(ing.flights.get("abc123")!.samples.map((s) => s.tMs)).toEqual([98_000, 100_000]);
  });

  it("starts a new flight with the next free ID after a gap, keeping the first ID", () => {
    const ing = new Ingester();
    ing.ingest({ now: 0, ac: [ac()] });
    ing.ingest({ now: FLIGHT_GAP_MS + 1, ac: [ac()] });
    ing.ingest({ now: 2 * FLIGHT_GAP_MS + 2, ac: [ac()] });
    expect([...ing.flights.keys()]).toEqual(["abc123", "abc123-1", "abc123-2"]);
    expect(ing.flights.get("abc123")!.samples).toHaveLength(1);
  });

  it("keeps callsign and type from the first report that has them", () => {
    const ing = new Ingester();
    ing.ingest({ now: 0, ac: [ac()] });
    ing.ingest({ now: 5_000, ac: [ac({ flight: "UAL1  ", t: "B789" })] });
    ing.ingest({ now: 10_000, ac: [ac({ flight: "UAL2", t: "A320" })] });
    expect(ing.flights.get("abc123")).toMatchObject({ flight: "UAL1", typeCode: "B789" });
  });

  it("keeps restored IDs taken and continues the restored flight", () => {
    const restored = { id: "abc123", hex: "abc123", samples: [{ ...sampleAt(0) }] };
    const old = { id: "def456", hex: "def456", samples: [{ ...sampleAt(0) }] };
    const ing = new Ingester([restored, old]);
    ing.ingest({ now: 5_000, ac: [ac()] });
    ing.ingest({ now: FLIGHT_GAP_MS + 1, ac: [ac({ hex: "def456" })] });
    expect(restored.samples).toHaveLength(2);
    expect([...ing.flights.keys()]).toEqual(["abc123", "def456", "def456-1"]);
  });
});

function sampleAt(tMs: number) {
  return { tMs, lat: 37.6, lon: -122.4, altBaroFt: 3000, altGeomFt: null, gsKt: null, trackDeg: null, baroRateFpm: null };
}
