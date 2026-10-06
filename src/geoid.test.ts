import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { geoidUndulationM, type GeoidGrid } from "./geoid";

// 3x3 grid on a 1-degree step; N = lat + 10 * lon offsets make each corner distinct.
const synthetic: GeoidGrid = {
  latMin: 0,
  latMax: 2,
  lonMin: 0,
  lonMax: 2,
  step: 1,
  values: [
    [0, 10, 20],
    [1, 11, 21],
    [2, 12, 22],
  ],
};

describe("geoidUndulationM", () => {
  it("returns exact values at grid nodes", () => {
    expect(geoidUndulationM(synthetic, 0, 0)).toBe(0);
    expect(geoidUndulationM(synthetic, 1, 2)).toBe(21);
    expect(geoidUndulationM(synthetic, 2, 2)).toBe(22);
  });

  it("interpolates bilinearly between nodes", () => {
    expect(geoidUndulationM(synthetic, 0.5, 0.5)).toBeCloseTo(5.5);
    expect(geoidUndulationM(synthetic, 1.25, 0.75)).toBeCloseTo(1.25 + 7.5);
  });

  it("handles the max edges without reading past the grid", () => {
    expect(geoidUndulationM(synthetic, 2, 1.5)).toBeCloseTo(17);
    expect(geoidUndulationM(synthetic, 1.5, 2)).toBeCloseTo(21.5);
  });

  it("throws outside the grid", () => {
    expect(() => geoidUndulationM(synthetic, -0.01, 1)).toThrow(RangeError);
    expect(() => geoidUndulationM(synthetic, 1, 2.01)).toThrow(RangeError);
  });
});

describe("EGM96 Bay Area grid", () => {
  const grid = JSON.parse(readFileSync("public/data/geoid-grid.json", "utf8")) as GeoidGrid;

  it("puts N at SFO between -35 and -29 m", () => {
    const n = geoidUndulationM(grid, 37.6189, -122.375);
    expect(n).toBeGreaterThanOrEqual(-35);
    expect(n).toBeLessThanOrEqual(-29);
  });

  it("covers the full 40 nm recording radius around SFO", () => {
    // 40 nm is about 0.67 deg of latitude and 0.84 deg of longitude at SFO.
    expect(() => geoidUndulationM(grid, 37.6189 + 0.67, -122.375 - 0.84)).not.toThrow();
    expect(() => geoidUndulationM(grid, 37.6189 - 0.67, -122.375 + 0.84)).not.toThrow();
  });
});
