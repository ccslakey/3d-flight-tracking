// Terrain heights for many positions without flooding the browser with tile requests.
// sampleTerrainMostDetailed fetches every tile it needs at once and Cesium does not throttle
// those requests, so a few thousand ground samples fail with ERR_INSUFFICIENT_RESOURCES.
// Positions are grouped by tile and sampled a few tiles at a time, with a limit shared by
// all callers.

import { Cartographic, sampleTerrainMostDetailed, type TerrainProvider } from "cesium";

const GROUPING_LEVEL = 16; // Cesium World Terrain's most detailed level around the Bay Area
const TILES_PER_BATCH = 8;
const MAX_CONCURRENT_BATCHES = 4;

let running = 0;
const waiting: (() => void)[] = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_BATCHES) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Ellipsoid heights in meters, or null where terrain could not be sampled. */
export async function sampleTerrainHeights(
  provider: TerrainProvider,
  positions: Cartographic[],
): Promise<(number | null)[]> {
  const byTile = new Map<string, number[]>();
  positions.forEach((p, i) => {
    const xy = provider.tilingScheme.positionToTileXY(p, GROUPING_LEVEL);
    const key = xy ? `${xy.x}/${xy.y}` : "outside";
    const indexes = byTile.get(key);
    if (indexes) indexes.push(i);
    else byTile.set(key, [i]);
  });

  const tiles = [...byTile.values()];
  const batches: number[][] = [];
  for (let i = 0; i < tiles.length; i += TILES_PER_BATCH) batches.push(tiles.slice(i, i + TILES_PER_BATCH).flat());

  const heights: (number | null)[] = positions.map(() => null);
  await Promise.all(
    batches.map((indexes) =>
      limited(async () => {
        const sampled = await sampleTerrainMostDetailed(
          provider,
          indexes.map((i) => Cartographic.clone(positions[i])),
        );
        sampled.forEach((c, j) => (heights[indexes[j]] = Number.isFinite(c.height) ? c.height : null));
      }),
    ),
  );
  return heights;
}
