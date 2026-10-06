// Builds a time-dynamic Cesium entity for one flight. Heights come only from altitude.ts;
// ground samples are clamped to the sampled terrain height.

import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  type Entity,
  ExtrapolationType,
  JulianDate,
  LabelStyle,
  LinearApproximation,
  SampledPositionProperty,
  sampleTerrainMostDetailed,
  type TerrainProvider,
  VerticalOrigin,
  type Viewer,
} from "cesium";
import { type AltResult, toEllipsoidHeight } from "./altitude";
import { geoidUndulationM, type GeoidGrid } from "./geoid";
import { type Metar, metarAt } from "./metar";
import type { TrackFile, TrackSample } from "./track";

export interface ReplayContext {
  geoid: GeoidGrid;
  metars: Metar[];
  geomReference: "HAE" | "MSL";
  terrainProvider: TerrainProvider;
}

export interface ResolvedSample {
  sample: TrackSample;
  geoidN: number;
  altimeterInHg: number;
  alt: AltResult;
  terrainHeightM: number | null; // set for ground samples
  heightM: number | null; // what is rendered: alt.heightM, or terrain height on the ground
}

/** Converts every sample to an ellipsoid height, sampling terrain for ground samples. */
export async function resolveSamples(track: TrackFile, ctx: ReplayContext): Promise<ResolvedSample[]> {
  const resolved: ResolvedSample[] = track.samples.map((sample) => {
    const geoidN = geoidUndulationM(ctx.geoid, sample.lat, sample.lon);
    const { altimeterInHg } = metarAt(ctx.metars, sample.tMs);
    const alt = toEllipsoidHeight(sample, { altimeterInHg, geoidN, geomReference: ctx.geomReference });
    return { sample, geoidN, altimeterInHg, alt, terrainHeightM: null, heightM: alt.heightM };
  });

  const ground = resolved.filter((r) => r.alt.source === "ground");
  if (ground.length) {
    const cartos = ground.map((r) => Cartographic.fromDegrees(r.sample.lon, r.sample.lat));
    const sampled = await sampleTerrainMostDetailed(ctx.terrainProvider, cartos);
    ground.forEach((r, i) => {
      const h = sampled[i].height;
      r.terrainHeightM = Number.isFinite(h) ? h : null;
      r.heightM = r.terrainHeightM;
    });
  }
  return resolved;
}

/** Adds the aircraft entity and sets the clock to the flight's time span. */
export function addFlightEntity(viewer: Viewer, track: TrackFile, resolved: ResolvedSample[]): Entity {
  const position = new SampledPositionProperty();
  // Linear avoids polynomial overshoot between irregular 5-10 s samples.
  position.setInterpolationOptions({ interpolationAlgorithm: LinearApproximation, interpolationDegree: 1 });
  position.forwardExtrapolationType = ExtrapolationType.HOLD;
  position.backwardExtrapolationType = ExtrapolationType.HOLD;

  const usable = resolved.filter((r) => r.heightM !== null);
  position.addSamples(
    usable.map((r) => JulianDate.fromDate(new Date(r.sample.tMs))),
    usable.map((r) => Cartesian3.fromDegrees(r.sample.lon, r.sample.lat, r.heightM!)),
  );

  const start = JulianDate.fromDate(new Date(usable[0].sample.tMs));
  const stop = JulianDate.fromDate(new Date(usable[usable.length - 1].sample.tMs));
  viewer.clock.startTime = start.clone();
  viewer.clock.stopTime = stop.clone();
  viewer.clock.currentTime = start.clone();
  viewer.clock.multiplier = 10;
  viewer.timeline.zoomTo(start, stop);

  return viewer.entities.add({
    id: `flight-${track.id}`,
    name: track.flight ?? track.hex,
    position,
    point: { pixelSize: 10, color: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 2 },
    label: {
      text: track.flight ?? track.hex,
      font: "13px sans-serif",
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 3,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -12),
    },
  });
}
