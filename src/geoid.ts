// Geoid undulation N (ellipsoid height minus MSL height, meters) from a precomputed
// EGM96 grid. See scripts/build-geoid-grid.py.

export interface GeoidGrid {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  step: number;
  values: number[][]; // values[latIndex][lonIndex], latIndex 0 = latMin
}

export async function loadGeoidGrid(url = "/data/geoid-grid.json"): Promise<GeoidGrid> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load geoid grid from ${url}: HTTP ${res.status}`);
  return (await res.json()) as GeoidGrid;
}

/** Bilinear interpolation of N at (lat, lon). Throws outside the grid. */
export function geoidUndulationM(grid: GeoidGrid, lat: number, lon: number): number {
  if (lat < grid.latMin || lat > grid.latMax || lon < grid.lonMin || lon > grid.lonMax) {
    throw new RangeError(`(${lat}, ${lon}) is outside the geoid grid`);
  }
  const rowCount = grid.values.length;
  const colCount = grid.values[0].length;

  const y = (lat - grid.latMin) / grid.step;
  const x = (lon - grid.lonMin) / grid.step;
  // Clamp so points on the max edge use the last cell rather than reading past it.
  const i = Math.min(Math.floor(y), rowCount - 2);
  const j = Math.min(Math.floor(x), colCount - 2);
  const fy = y - i;
  const fx = x - j;

  const v00 = grid.values[i][j];
  const v01 = grid.values[i][j + 1];
  const v10 = grid.values[i + 1][j];
  const v11 = grid.values[i + 1][j + 1];
  return v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
}
