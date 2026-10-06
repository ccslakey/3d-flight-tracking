// Builds time-dynamic Cesium entities for recorded flights. Heights come only from
// altitude.ts; ground samples are clamped to the sampled terrain height.

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
  NearFarScalar,
  SampledPositionProperty,
  sampleTerrainMostDetailed,
  type TerrainProvider,
  TimeInterval,
  TimeIntervalCollection,
  VerticalOrigin,
  type Viewer,
} from "cesium";
import { type AltResult, toEllipsoidHeight } from "./altitude";
import { geoidUndulationM, type GeoidGrid } from "./geoid";
import { type Metar, metarAt } from "./metar";
import type { TrackFile, TrackSample } from "./track";

const TRAIL_SECONDS = 90;
const LANDING_COLOR = Color.fromCssColorString("#7cf29a");
const OTHER_COLOR = Color.WHITE;

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

export interface ReplayFlight {
  track: TrackFile;
  resolved: ResolvedSample[];
  entity: Entity;
  startMs: number;
  stopMs: number;
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

/** Adds one aircraft entity that exists only during its recorded time span. Null if it has no usable heights. */
export function addFlightEntity(viewer: Viewer, track: TrackFile, resolved: ResolvedSample[]): ReplayFlight | null {
  const usable = resolved.filter((r) => r.heightM !== null);
  if (usable.length < 2) return null;

  const position = new SampledPositionProperty();
  // Linear avoids polynomial overshoot between irregular 5-10 s samples.
  position.setInterpolationOptions({ interpolationAlgorithm: LinearApproximation, interpolationDegree: 1 });
  position.forwardExtrapolationType = ExtrapolationType.HOLD;
  position.backwardExtrapolationType = ExtrapolationType.HOLD;
  position.addSamples(
    usable.map((r) => JulianDate.fromDate(new Date(r.sample.tMs))),
    usable.map((r) => Cartesian3.fromDegrees(r.sample.lon, r.sample.lat, r.heightM!)),
  );

  const startMs = usable[0].sample.tMs;
  const stopMs = usable[usable.length - 1].sample.tMs;
  const color = track.landing ? LANDING_COLOR : OTHER_COLOR;

  const entity = viewer.entities.add({
    id: `flight-${track.id}`,
    name: track.flight ?? track.hex,
    availability: new TimeIntervalCollection([
      new TimeInterval({ start: JulianDate.fromDate(new Date(startMs)), stop: JulianDate.fromDate(new Date(stopMs)) }),
    ]),
    position,
    point: { pixelSize: 8, color, outlineColor: Color.BLACK, outlineWidth: 1.5 },
    path: { leadTime: 0, trailTime: TRAIL_SECONDS, width: 1.5, material: color.withAlpha(0.5) },
    label: {
      text: track.flight ?? track.hex,
      font: "12px sans-serif",
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 3,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -10),
      // Fade labels out with distance so the whole-area view stays readable.
      translucencyByDistance: new NearFarScalar(15_000, 1, 60_000, 0),
    },
  });
  return { track, resolved, entity, startMs, stopMs };
}

/** Sets the clock and timeline to span the given time range. */
export function setClockRange(viewer: Viewer, startMs: number, stopMs: number): void {
  const start = JulianDate.fromDate(new Date(startMs));
  const stop = JulianDate.fromDate(new Date(stopMs));
  viewer.clock.startTime = start.clone();
  viewer.clock.stopTime = stop.clone();
  viewer.clock.currentTime = start.clone();
  viewer.clock.multiplier = 10;
  viewer.timeline.zoomTo(start, stop);
}
