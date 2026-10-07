// Builds time-dynamic Cesium entities for recorded flights. Heights come only from
// altitude.ts; ground samples are clamped to the sampled terrain height.

import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorBlendMode,
  type Entity,
  ExtrapolationType,
  HeadingPitchRoll,
  JulianDate,
  LabelStyle,
  LinearApproximation,
  Math as CesiumMath,
  NearFarScalar,
  Quaternion,
  SampledPositionProperty,
  SampledProperty,
  type TerrainProvider,
  TimeInterval,
  TimeIntervalCollection,
  Transforms,
  VerticalOrigin,
  type Viewer,
} from "cesium";
import { type AltResult, ellipsoidMToMslFt, flightPathAngleRad, toEllipsoidHeight } from "./altitude";
import { geoidUndulationM, type GeoidGrid } from "./geoid";
import { type Metar, metarAt } from "./metar";
import { sampleTerrainHeights } from "./terrain";
import type { TrackFile, TrackSample } from "./track";

const TRAIL_SECONDS = 90;
const MODEL_URL = "/models/airliner.glb";
const LANDING_COLOR = Color.fromCssColorString("#7cf29a");
const OTHER_COLOR = Color.WHITE;
// Shorter moves between samples are position noise, not a direction of travel.
const MIN_MOTION_M = 15;

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
  usable: ResolvedSample[]; // resolved samples with a height, which drive the entity
  entity: Entity;
  startMs: number;
  stopMs: number;
  holdAfterMs: number; // stays shown at its last position this long after its last sample
}

/** Resolves several tracks' samples with one terrain query, so tiles they share are fetched once. */
export async function resolveSampleGroups(groups: TrackSample[][], ctx: ReplayContext): Promise<ResolvedSample[][]> {
  const all = await resolveSamples(groups.flat(), ctx);
  let i = 0;
  return groups.map((g) => all.slice(i, (i += g.length)));
}

/** Converts samples to ellipsoid heights, sampling terrain for ground samples in one batch. */
export async function resolveSamples(samples: TrackSample[], ctx: ReplayContext): Promise<ResolvedSample[]> {
  const resolved: ResolvedSample[] = samples.map((sample) => {
    const geoidN = geoidUndulationM(ctx.geoid, sample.lat, sample.lon);
    const { altimeterInHg } = metarAt(ctx.metars, sample.tMs);
    const alt = toEllipsoidHeight(sample, { altimeterInHg, geoidN, geomReference: ctx.geomReference });
    return { sample, geoidN, altimeterInHg, alt, terrainHeightM: null, heightM: alt.heightM };
  });

  const ground = resolved.filter((r) => r.alt.source === "ground");
  if (ground.length) {
    const cartos = ground.map((r) => Cartographic.fromDegrees(r.sample.lon, r.sample.lat));
    const heights = await sampleTerrainHeights(ctx.terrainProvider, cartos);
    ground.forEach((r, i) => {
      r.terrainHeightM = heights[i];
      r.heightM = r.terrainHeightM;
    });
  }
  return resolved;
}

/** Initial bearing from a to b in degrees from north, or null if they are too close to give a direction. */
function motionBearingDeg(a: TrackSample, b: TrackSample): number | null {
  const toRad = Math.PI / 180;
  const dNorthM = (b.lat - a.lat) * 111_320;
  const dEastM = (b.lon - a.lon) * 111_320 * Math.cos(a.lat * toRad);
  if (Math.hypot(dNorthM, dEastM) < MIN_MOTION_M) return null;
  return (Math.atan2(dEastM, dNorthM) / toRad + 360) % 360;
}

/**
 * Heading per sample in degrees from north. Airborne samples use the recorded track. Ground
 * samples rarely carry a track and often hold a stale one, so they use true heading, then the
 * bearing of the segment being driven, then the last known heading while stopped. Some
 * transponders freeze true heading, so it is ignored if it never changes while moving.
 */
function sampleHeadingsDeg(usable: ResolvedSample[]): (number | null)[] {
  const motions = usable.map((r, i) => {
    const s = r.sample;
    const next = usable[i + 1]?.sample;
    const prev = usable[i - 1]?.sample;
    return (next && motionBearingDeg(s, next)) ?? (prev && motionBearingDeg(prev, s)) ?? null;
  });
  const movingTrueHeadings = usable
    .filter((r, i) => r.alt.source === "ground" && motions[i] !== null)
    .map((r) => r.sample.trueHeadingDeg)
    .filter((h) => h != null);
  const trueHeadingFrozen = movingTrueHeadings.length > 1 && new Set(movingTrueHeadings).size === 1;
  const headings: (number | null)[] = usable.map((r, i) => {
    const s = r.sample;
    if (r.alt.source === "ground") return (trueHeadingFrozen ? null : s.trueHeadingDeg) ?? motions[i];
    return s.trackDeg ?? motions[i];
  });
  // Hold through stops, and backfill a leading stop with the first known heading.
  let last = headings.find((h) => h !== null) ?? null;
  return headings.map((h) => (last = h ?? last));
}

/** Orientation from each sample's heading and climb angle, smoother than velocity between sparse samples. */
function buildOrientation(usable: ResolvedSample[]): SampledProperty {
  const orientation = new SampledProperty(Quaternion);
  orientation.forwardExtrapolationType = ExtrapolationType.HOLD;
  orientation.backwardExtrapolationType = ExtrapolationType.HOLD;
  const headings = sampleHeadingsDeg(usable);
  usable.forEach((r, i) => {
    const trackDeg = headings[i];
    if (trackDeg === null) return;
    const { gsKt, baroRateFpm } = r.sample;
    const onGround = r.alt.source === "ground";
    const pitch = onGround || gsKt === null || baroRateFpm === null ? 0 : flightPathAngleRad(baroRateFpm, gsKt);
    // Cesium model heading is measured from east; ADS-B track is measured from north.
    const hpr = new HeadingPitchRoll(CesiumMath.toRadians(trackDeg - 90), pitch, 0);
    const position = Cartesian3.fromDegrees(r.sample.lon, r.sample.lat, r.heightM!);
    orientation.addSample(JulianDate.fromDate(new Date(r.sample.tMs)), Transforms.headingPitchRollQuaternion(position, hpr));
  });
  return orientation;
}

/** Callsign, MSL altitude, ground speed, and vertical rate at the current replay time. */
function liveLabel(
  name: string,
  usable: ResolvedSample[],
  position: SampledPositionProperty,
  geoid: GeoidGrid,
): CallbackProperty {
  const scratch = new Cartographic();
  return new CallbackProperty((time) => {
    const p = position.getValue(time!);
    if (!p || !time) return name;
    const carto = Cartographic.fromCartesian(p, undefined, scratch);
    const lat = CesiumMath.toDegrees(carto.latitude);
    const lon = CesiumMath.toDegrees(carto.longitude);
    const altFt = ellipsoidMToMslFt(carto.height, geoidUndulationM(geoid, lat, lon));

    // Speeds from the latest sample at or before this time.
    const tMs = JulianDate.toDate(time).getTime();
    let lo = 0;
    let hi = usable.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (usable[mid].sample.tMs <= tMs) lo = mid;
      else hi = mid - 1;
    }
    const { gsKt, baroRateFpm } = usable[lo].sample;
    const onGround = usable[lo].alt.source === "ground";
    const alt = onGround ? "GND" : `${Math.round(altFt / 25) * 25} ft`;
    const speed = gsKt !== null ? `${Math.round(gsKt)} kt` : "";
    const vs =
      !onGround && baroRateFpm !== null && Math.abs(baroRateFpm) >= 100
        ? `\n${baroRateFpm > 0 ? "▲" : "▼"} ${Math.abs(Math.round(baroRateFpm / 50) * 50)} fpm`
        : "";
    return `${name}\n${alt}  ${speed}${vs}`;
  }, false);
}

/**
 * Adds one aircraft entity that exists only during its recorded time span, plus `holdAfterMs`.
 * Null if it has no usable heights.
 */
export function addFlightEntity(
  viewer: Viewer,
  track: TrackFile,
  resolved: ResolvedSample[],
  geoid: GeoidGrid,
  holdAfterMs = 0,
): ReplayFlight | null {
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
  const name = track.flight ?? track.hex;

  const entity = viewer.entities.add({
    id: `flight-${track.id}`,
    name,
    availability: new TimeIntervalCollection([timeInterval(startMs, stopMs + holdAfterMs)]),
    position,
    orientation: buildOrientation(usable),
    model: {
      uri: MODEL_URL,
      // Real size up close, but never smaller than this on screen.
      minimumPixelSize: 28,
      maximumScale: 400,
      color,
      colorBlendMode: ColorBlendMode.MIX,
      colorBlendAmount: 0.35,
      silhouetteColor: Color.BLACK.withAlpha(0.6),
      silhouetteSize: 1,
    },
    path: { leadTime: 0, trailTime: TRAIL_SECONDS, width: 1.5, material: color.withAlpha(0.5) },
    label: {
      text: liveLabel(name, usable, position, geoid),
      font: "12px sans-serif",
      showBackground: false,
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 3,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -18),
      // Fade labels out with distance so the whole-area view stays readable.
      translucencyByDistance: new NearFarScalar(15_000, 1, 60_000, 0),
    },
  });
  return { track, resolved, usable, entity, startMs, stopMs, holdAfterMs };
}

const timeInterval = (startMs: number, stopMs: number) =>
  new TimeInterval({ start: JulianDate.fromDate(new Date(startMs)), stop: JulianDate.fromDate(new Date(stopMs)) });

/** Extends a flight with samples that are all later than its current ones. */
export function appendResolved(flight: ReplayFlight, added: ResolvedSample[]): void {
  flight.resolved.push(...added);
  const usable = added.filter((r) => r.heightM !== null);
  if (!usable.length) return;
  flight.usable.push(...usable);
  (flight.entity.position as SampledPositionProperty).addSamples(
    usable.map((r) => JulianDate.fromDate(new Date(r.sample.tMs))),
    usable.map((r) => Cartesian3.fromDegrees(r.sample.lon, r.sample.lat, r.heightM!)),
  );
  // Headings depend on neighboring samples and the whole flight, so rebuild them.
  flight.entity.orientation = buildOrientation(flight.usable);
  flight.stopMs = usable[usable.length - 1].sample.tMs;
  updateAvailability(flight);
}

/** Drops samples before `startMs`. Returns false if no samples with a height remain. */
export function trimFlightBefore(flight: ReplayFlight, startMs: number): boolean {
  const firstKept = (list: ResolvedSample[]) => {
    const i = list.findIndex((r) => r.sample.tMs >= startMs);
    return i < 0 ? list.length : i;
  };
  const usableDropped = firstKept(flight.usable);
  flight.resolved.splice(0, firstKept(flight.resolved));
  if (!usableDropped) return true;
  flight.usable.splice(0, usableDropped);
  if (!flight.usable.length) return false;

  (flight.entity.position as SampledPositionProperty).removeSamples(
    new TimeInterval({
      start: JulianDate.fromDate(new Date(flight.startMs)),
      stop: JulianDate.fromDate(new Date(startMs)),
      isStopIncluded: false,
    }),
  );
  flight.entity.orientation = buildOrientation(flight.usable);
  flight.startMs = flight.usable[0].sample.tMs;
  updateAvailability(flight);
  return true;
}

/** Mutated in place: drop lines share this collection. */
function updateAvailability(flight: ReplayFlight): void {
  flight.entity.availability!.removeAll();
  flight.entity.availability!.addInterval(timeInterval(flight.startMs, flight.stopMs + flight.holdAfterMs));
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
