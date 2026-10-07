// Live mode: loads the relay's recent history, then appends each poll's samples as they
// stream in. The clock follows a live edge a little behind the latest data, so every
// aircraft has a next sample to move toward; scrubbing back replays history as usual.

import { ClockRange, JulianDate, type Viewer } from "cesium";
import { parseMetars, type RawMetar } from "./metar";
import { addFlightEntity, appendResolved, type ReplayContext, type ReplayFlight, resolveSamples } from "./replay";
import type { LiveSamplesEvent, TrackFile, TrackSample } from "./track";

const LIVE_DELAY_MS = 15_000;
// Polls rate-limited by adsb.lol leave gaps longer than the delay. Holding each aircraft at its
// last position this long keeps the whole sky from blinking out until the next poll.
export const LIVE_HOLD_MS = 30_000;
const RESUME_WITHIN_S = 1; // reaching this close to the live edge resumes following
const TIMELINE_REZOOM_MS = 60_000;

export interface LiveFeed {
  tracks: TrackFile[];
  rawMetars: RawMetar[];
  /** Starts delivering events, beginning with any that arrived while history loaded. */
  run(handler: (e: MessageEvent<string>, receivedAtMs: number) => void): void;
}

/** Subscribes to live events first, then loads history, so nothing is missed in between. */
export async function connectLive(): Promise<LiveFeed> {
  const source = new EventSource("/api/live");
  const queued: [MessageEvent<string>, number][] = [];
  let deliver: ((e: MessageEvent<string>, receivedAtMs: number) => void) | null = null;
  const onEvent = (e: MessageEvent<string>) => (deliver ? deliver(e, Date.now()) : queued.push([e, Date.now()]));
  source.addEventListener("samples", onEvent);
  source.addEventListener("metar", onEvent);

  const res = await fetch("/api/history");
  if (!res.ok) throw new Error(`Live relay unavailable (HTTP ${res.status}). Start it with npm run relay.`);
  const history = (await res.json()) as { flights: TrackFile[]; metars: RawMetar[] };
  return {
    tracks: history.flights,
    rawMetars: history.metars,
    run(handler) {
      deliver = handler;
      for (const [e, receivedAtMs] of queued.splice(0)) handler(e, receivedAtMs);
    },
  };
}

/** Applies live events to the scene and runs the live-edge clock. `onNewFlight` is called for each aircraft that appears. */
export function runLive(
  viewer: Viewer,
  ctx: ReplayContext,
  feed: LiveFeed,
  flights: ReplayFlight[],
  onNewFlight: (flight: ReplayFlight) => void,
): void {
  const tracksById = new Map(feed.tracks.map((t) => [t.id, t]));
  const flightsById = new Map(flights.map((f) => [f.track.id, f]));
  const rawMetars = [...feed.rawMetars];
  // Relay data time minus local time, so the viewer's clock offset does not matter.
  let serverOffsetMs = 0;

  async function applySamples(event: LiveSamplesEvent): Promise<void> {
    const fresh: { track: TrackFile; samples: TrackSample[] }[] = [];
    for (const update of event.flights) {
      let track = tracksById.get(update.id);
      if (!track) tracksById.set(update.id, (track = { id: update.id, hex: update.hex, landing: null, samples: [] }));
      track.flight ??= update.flight;
      track.typeCode ??= update.typeCode;
      const lastMs = track.samples[track.samples.length - 1]?.tMs ?? -Infinity;
      const samples = update.samples.filter((s) => s.tMs > lastMs);
      if (!samples.length) continue;
      track.samples.push(...samples);
      fresh.push({ track, samples });
    }

    // One terrain query for the whole poll.
    const resolved = await resolveSamples(
      fresh.flatMap((f) => f.samples),
      ctx,
    );
    let i = 0;
    for (const { track, samples } of fresh) {
      const added = resolved.slice(i, (i += samples.length));
      const flight = flightsById.get(track.id);
      if (flight) {
        appendResolved(flight, added);
        continue;
      }
      // Not rendered yet: needs two samples with heights. Resolve the earlier ones too.
      const earlier = await resolveSamples(track.samples.slice(0, -samples.length), ctx);
      const created = addFlightEntity(viewer, track, [...earlier, ...added], ctx.geoid, LIVE_HOLD_MS);
      if (!created) continue;
      flightsById.set(track.id, created);
      onNewFlight(created);
    }
  }

  // Events are applied strictly in order, even though resolving them is async.
  let chain = Promise.resolve();
  feed.run((e, receivedAtMs) => {
    let apply: () => Promise<void> | void;
    if (e.type === "metar") {
      const { metars } = JSON.parse(e.data) as { metars: RawMetar[] };
      apply = () => {
        rawMetars.push(...metars);
        ctx.metars = parseMetars(rawMetars);
      };
    } else {
      const event = JSON.parse(e.data) as LiveSamplesEvent;
      // Measured on arrival: applying an event can lag behind it.
      serverOffsetMs = event.now - receivedAtMs;
      apply = () => applySamples(event);
    }
    chain = chain.then(apply).catch((err) => console.error("Live update failed", err));
  });

  setUpLiveClock(viewer, feed.tracks, () => Date.now() + serverOffsetMs - LIVE_DELAY_MS);
}

function setUpLiveClock(viewer: Viewer, tracks: TrackFile[], liveEdgeMs: () => number): void {
  const { clock, timeline } = viewer;
  const toJulian = (ms: number) => JulianDate.fromDate(new Date(ms));
  const firstMs = Math.min(...tracks.map((t) => t.samples[0].tMs), liveEdgeMs() - 60_000);
  clock.startTime = toJulian(firstMs);
  clock.stopTime = toJulian(liveEdgeMs());
  clock.currentTime = clock.stopTime.clone();
  // Clamped by hand below: with CLAMPED, the animation widget pauses whenever the time equals the stop time.
  clock.clockRange = ClockRange.UNBOUNDED;
  clock.multiplier = 1;
  clock.shouldAnimate = true;
  timeline.zoomTo(clock.startTime, clock.stopTime);
  setInterval(() => timeline.zoomTo(clock.startTime, clock.stopTime), TIMELINE_REZOOM_MS);

  const button = document.createElement("button");
  button.className = "live-button";
  button.textContent = "LIVE";
  button.title = "Jump to live";
  document.body.append(button);

  let following = true;
  const setFollowing = (on: boolean) => {
    following = on;
    if (on) clock.multiplier = 1;
    button.classList.toggle("is-live", on);
  };
  setFollowing(true);

  button.addEventListener("click", () => {
    clock.shouldAnimate = true;
    setFollowing(true);
  });
  // Scrubbing the timeline leaves live; the tick handler resumes if it lands on the edge.
  timeline.container.addEventListener("settime", () => setFollowing(false));

  clock.onTick.addEventListener(() => {
    const edge = toJulian(liveEdgeMs());
    clock.stopTime = edge;
    if (following && (!clock.shouldAnimate || clock.multiplier !== 1)) setFollowing(false);
    if (!following && clock.shouldAnimate && JulianDate.secondsDifference(edge, clock.currentTime) < RESUME_WITHIN_S) {
      setFollowing(true);
    }
    if (following || JulianDate.greaterThan(clock.currentTime, edge)) clock.currentTime = edge;
    else if (JulianDate.lessThan(clock.currentTime, clock.startTime)) clock.currentTime = clock.startTime.clone();
  });
}
