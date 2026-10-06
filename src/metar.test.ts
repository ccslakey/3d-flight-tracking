import { describe, expect, it } from "vitest";
import { metarAt, parseAltimeter, parseMetars, type RawMetar } from "./metar";

const raw = (obsTime: number, rawOb: string, altim?: number): RawMetar => ({ obsTime, rawOb, altim });

describe("parseAltimeter", () => {
  it("reads the A group in inHg", () => {
    const m = raw(0, "METAR KSFO 060356Z 29012KT 10SM FEW008 16/13 A2991 RMK AO2 SLP129 T01610133", 1013);
    expect(parseAltimeter(m)).toEqual({ altimeterInHg: 29.91, altimeterSource: "A-group" });
  });

  it("converts a Q group from hPa", () => {
    const m = raw(0, "METAR EGLL 060350Z 27010KT 9999 FEW030 12/08 Q1013");
    expect(parseAltimeter(m).altimeterInHg).toBeCloseTo(1013 / 33.8639, 4);
    expect(parseAltimeter(m).altimeterSource).toBe("Q-group");
  });

  it("falls back to the JSON altim field in hPa", () => {
    const m = raw(0, "METAR KSFO 060356Z 29012KT 10SM FEW008 16/13 RMK AO2", 1020);
    expect(parseAltimeter(m)).toEqual({ altimeterInHg: 1020 / 33.8639, altimeterSource: "altim-hPa" });
  });

  it("ignores A-like groups in remarks", () => {
    const m = raw(0, "METAR KSFO 060356Z 29012KT 10SM 16/13 RMK A3010", 1013);
    expect(parseAltimeter(m).altimeterSource).toBe("altim-hPa");
  });

  it("throws when no altimeter is present", () => {
    expect(() => parseAltimeter(raw(0, "METAR KSFO 060356Z 29012KT 10SM 16/13"))).toThrow();
  });
});

describe("metarAt", () => {
  // Deliberately unsorted; parseMetars sorts.
  const metars = parseMetars([
    raw(7200, "METAR KSFO 060256Z 30013KT 10SM 17/13 A2990"),
    raw(3600, "METAR KSFO 060156Z 31013KT 10SM 18/13 A2988"),
    raw(10800, "METAR KSFO 060356Z 29012KT 10SM 16/13 A2991"),
  ]);

  it("picks the latest METAR at or before the sample, not the latest overall", () => {
    expect(metarAt(metars, 5000_000).altimeterInHg).toBe(29.88);
    expect(metarAt(metars, 9000_000).altimeterInHg).toBe(29.9);
  });

  it("includes a METAR observed exactly at the sample time", () => {
    expect(metarAt(metars, 7200_000).altimeterInHg).toBe(29.9);
  });

  it("uses the last METAR after the final observation", () => {
    expect(metarAt(metars, 99_999_000).altimeterInHg).toBe(29.91);
  });

  it("throws before the first METAR", () => {
    expect(() => metarAt(metars, 3599_000)).toThrow(RangeError);
  });
});
