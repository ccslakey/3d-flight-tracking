import { describe, expect, it } from "vitest";
import { toEllipsoidHeight, uncorrectedBaroToEllipsoidM, type AltContext } from "./altitude";

const N = -32;
const std: AltContext = { altimeterInHg: 29.92, geoidN: N, geomReference: "HAE" };

describe("toEllipsoidHeight", () => {
  describe("baro-corrected", () => {
    it("applies no correction at 29.92 inHg", () => {
      const r = toEllipsoidHeight({ altBaroFt: 1000, altGeomFt: null }, std);
      expect(r.source).toBe("baro-corrected");
      expect(r.heightM).toBeCloseTo(1000 * 0.3048 + N);
    });

    it("raises MSL altitude on a high-pressure day", () => {
      const r = toEllipsoidHeight({ altBaroFt: 1000, altGeomFt: null }, { ...std, altimeterInHg: 30.42 });
      expect(r.heightM).toBeCloseTo(1500 * 0.3048 + N);
    });

    it("lowers MSL altitude on a low-pressure day", () => {
      const r = toEllipsoidHeight({ altBaroFt: 1000, altGeomFt: null }, { ...std, altimeterInHg: 29.42 });
      expect(r.heightM).toBeCloseTo(500 * 0.3048 + N);
    });

    it("puts an aircraft on the SFO runway at field elevation", () => {
      // At 30.12 inHg, an aircraft at 13 ft MSL reads 200 ft lower in pressure altitude.
      const r = toEllipsoidHeight({ altBaroFt: 13 - 200, altGeomFt: null }, { ...std, altimeterInHg: 30.12 });
      expect(r.heightM).toBeCloseTo(13 * 0.3048 + N);
    });

    it("leaves the uncorrected debug value off by (altimeter - 29.92) * 1000 ft", () => {
      const corrected = toEllipsoidHeight({ altBaroFt: 1000, altGeomFt: null }, { ...std, altimeterInHg: 30.12 });
      expect(corrected.heightM! - uncorrectedBaroToEllipsoidM(1000, N)).toBeCloseTo(200 * 0.3048);
    });
  });

  describe("geom", () => {
    it("uses geom when baro is missing, with no N for HAE", () => {
      const r = toEllipsoidHeight({ altBaroFt: null, altGeomFt: 1000 }, std);
      expect(r).toEqual({ heightM: expect.closeTo(304.8), source: "geom" });
    });

    it("adds N when geom is MSL", () => {
      const r = toEllipsoidHeight({ altBaroFt: null, altGeomFt: 1000 }, { ...std, geomReference: "MSL" });
      expect(r.heightM).toBeCloseTo(304.8 + N);
    });
  });

  describe("both present", () => {
    it("prefers geom and reports geom minus baro", () => {
      const r = toEllipsoidHeight({ altBaroFt: 1000, altGeomFt: 1000 }, std);
      expect(r.source).toBe("geom");
      expect(r.heightM).toBeCloseTo(304.8);
      // HAE geom has no N, baro does, so geom sits |N| above baro.
      expect(r.deltaGeomBaroM).toBeCloseTo(-N);
    });

    it("reports zero delta when an MSL-referenced geom matches baro", () => {
      const r = toEllipsoidHeight({ altBaroFt: 1000, altGeomFt: 1000 }, { ...std, geomReference: "MSL" });
      expect(r.deltaGeomBaroM).toBeCloseTo(0);
    });
  });

  describe("ground and missing", () => {
    it("returns ground with no height", () => {
      expect(toEllipsoidHeight({ altBaroFt: "ground", altGeomFt: null }, std)).toEqual({
        heightM: null,
        source: "ground",
      });
    });

    it("returns ground even if geom is present", () => {
      expect(toEllipsoidHeight({ altBaroFt: "ground", altGeomFt: 50 }, std).source).toBe("ground");
    });

    it("returns none when no altitude is reported", () => {
      expect(toEllipsoidHeight({ altBaroFt: null, altGeomFt: null }, std)).toEqual({ heightM: null, source: "none" });
    });
  });
});
