// Live mode: loads the relay's recent history, then appends each poll's samples as they
// stream in. The clock follows a live edge a little behind the latest data, so every
// aircraft has a next sample to move toward; scrubbing back replays history as usual.

import { ClockRange, JulianDate, type Viewer } from "cesium";
import { parseMetars, type RawMetar } from "./metar";
import { FLIGHT_GAP_MS } from "./ingest";
import {
  addFlightEntity,
  appendResolved,
  type ReplayContext,
  type ReplayFlight,
  resolveSampleGroups,
  trimFlightBefore,
} from "./replay";
import type { LiveFlightSamples, LiveSamplesEvent, TrackFile, TrackSample } from "./track";

const LIVE_DELAY_MS = 15_000;
// Polls rate-limited by adsb.lol leave gaps longer than the delay. Holding each aircraft at its
// last position this long keeps the whole sky from blinking out until the next poll.
export const LIVE_HOLD_MS = 30_000;
const RESUME_WITHIN_S = 1; // reaching this close to the live edge resumes following
const TIMELINE_REZOOM_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;
// Gap fill starts this far before the last data seen, since positions arrive up to 15 s old.
const GAP_FILL_MARGIN_MS = 60_000;
const RECONNECT_MS = 3_000;
const STALE_STREAM_MS = 40_000; // the relay pings every 15 s

interface History {
  flights: TrackFile[];
  metars: RawMetar[];
  retentionMs: number;
}

/** Live input in arrival order. `reconnected` marks a dropped stream coming back. */
export type LiveMessage =
  | { kind: "samples"; event: LiveSamplesEvent; receivedAtMs: number }
  | { kind: "metar"; metars: RawMetar[] }
  | { kind: "reconnected" };

export interface LiveFeed {
  tracks: TrackFile[];
  rawMetars: RawMetar[];
  retentionMs: number;
  /** Starts delivering messages, beginning with any that arrived while history loaded. */
  run(handler: (message: LiveMessage) => void): void;
  /** Whether the event stream is open, and when the page last heard from it. */
  stream(): { open: boolean; lastHeardMs: number };
}

async function fetchHistory(fromMs?: number): Promise<History> {
  const res = await fetch(fromMs === undefined ? "/api/history" : `/api/history?from=${Math.floor(fromMs)}`);
  if (!res.ok) throw new Error(`Live relay unavailable (HTTP ${res.status}). Start it with npm run relay.`);
  return (await res.json()) as History;
}

/** Subscribes to live events first, then loads history, so nothing is missed in between. */
export async function connectLive(): Promise<LiveFeed> {
  const queued: LiveMessage[] = [];
  let deliver: ((message: LiveMessage) => void) | null = null;
  const push = (message: LiveMessage) => (deliver ? deliver(message) : queued.push(message));
  let opened = false;
  let source: EventSource;
  let lastHeardMs = Date.now();
  const subscribe = () => {
    source = new EventSource("/api/live");
    lastHeardMs = Date.now();
    for (const type of ["open", "samples", "metar", "ping"]) source.addEventListener(type, () => (lastHeardMs = Date.now()));
    source.addEventListener("samples", (e) =>
      push({ kind: "samples", event: JSON.parse(e.data) as LiveSamplesEvent, receivedAtMs: Date.now() }),
    );
    source.addEventListener("metar", (e) => push({ kind: "metar", metars: (JSON.parse(e.data) as { metars: RawMetar[] }).metars }));
    // Every open after the first follows a drop.
    source.addEventListener("open", () => {
      if (opened) push({ kind: "reconnected" });
      opened = true;
    });
  };
  subscribe();
  // EventSource retries network errors itself but gives up on an HTTP error, such as the dev
  // proxy's while the relay is down. A stream can also hang open with no error when the relay
  // dies behind a proxy. Either way, start over.
  setInterval(() => {
    if (source.readyState !== EventSource.CLOSED && Date.now() - lastHeardMs < STALE_STREAM_MS) return;
    source.close();
    subscribe();
  }, RECONNECT_MS);

  const history = await fetchHistory();
  return {
    tracks: history.flights,
    rawMetars: history.metars,
    retentionMs: history.retentionMs,
    run(handler) {
      deliver = handler;
      for (const message of queued.splice(0)) handler(message);
    },
    stream: () => ({ open: source.readyState === EventSource.OPEN, lastHeardMs }),
  };
}

export interface LiveHooks {
  added(flight: ReplayFlight): void;
  /** Samples were appended or trimmed. */
  changed(flight: ReplayFlight): void;
  /** Its entity is already removed from the viewer. */
  removed(flight: ReplayFlight): void;
}

/** Applies live events to the scene, keeps it trimmed to the retention window, and runs the live-edge clock. */
export function runLive(viewer: Viewer, ctx: ReplayContext, feed: LiveFeed, flights: ReplayFlight[], hooks: LiveHooks): void {
  const tracksById = new Map(feed.tracks.map((t) => [t.id, t]));
  const flightsById = new Map(flights.map((f) => [f.track.id, f]));
  let rawMetars = [...feed.rawMetars];
  // Relay data time minus local time, so the viewer's clock offset does not matter.
  let serverOffsetMs = 0;
  let latestEventNowMs: number | null = null;
  const serverNowMs = () => Date.now() + serverOffsetMs;

  function removeFlight(id: string): void {
    tracksById.delete(id);
    const flight = flightsById.get(id);
    if (!flight) return;
    flightsById.delete(id);
    viewer.entities.remove(flight.entity);
    hooks.removed(flight);
  }

  async function applySamples(updates: LiveFlightSamples[]): Promise<void> {
    const fresh: { track: TrackFile; samples: TrackSample[] }[] = [];
    for (const update of updates) {
      let track = tracksById.get(update.id);
      const lastMs = track?.samples[track.samples.length - 1]?.tMs ?? -Infinity;
      // An ID freed by the relay's pruning and reused for a new flight before this page pruned it.
      if (track && update.samples[0] && update.samples[0].tMs - lastMs > FLIGHT_GAP_MS) {
        removeFlight(update.id);
        track = undefined;
      }
      if (!track) tracksById.set(update.id, (track = { id: update.id, hex: update.hex, landing: null, samples: [] }));
      track.flight ??= update.flight;
      track.typeCode ??= update.typeCode;
      const samples = update.samples.filter((s) => s.tMs > (track.samples[track.samples.length - 1]?.tMs ?? -Infinity));
      if (!samples.length) continue;
      track.samples.push(...samples);
      fresh.push({ track, samples });
    }

    // One terrain query for the whole batch. Flights not rendered yet need two samples with
    // heights, so their earlier samples are resolved again with the new ones.
    const resolved = await resolveSampleGroups(
      fresh.map(({ track, samples }) => (flightsById.has(track.id) ? samples : track.samples)),
      ctx,
    );
    fresh.forEach(({ track }, i) => {
      const flight = flightsById.get(track.id);
      if (flight) {
        appendResolved(flight, resolved[i]);
        hooks.changed(flight);
        return;
      }
      const created = addFlightEntity(viewer, track, resolved[i], ctx.geoid, LIVE_HOLD_MS);
      if (!created) return;
      flightsById.set(track.id, created);
      hooks.added(created);
    });
  }

  function addMetars(metars: RawMetar[]): void {
    const known = new Set(rawMetars.map((m) => m.obsTime));
    const added = metars.filter((m) => !known.has(m.obsTime));
    if (!added.length) return;
    rawMetars.push(...added);
    ctx.metars = parseMetars(rawMetars);
  }

  /** Fetches what the relay received while the stream was down. Overlap is dropped by sample time. */
  async function fillGap(): Promise<void> {
    const lastSampleMs = Math.max(...[...tracksById.values()].map((t) => t.samples[t.samples.length - 1]?.tMs ?? -Infinity));
    const fromMs = (latestEventNowMs ?? lastSampleMs) - GAP_FILL_MARGIN_MS;
    const history = await fetchHistory(Number.isFinite(fromMs) ? fromMs : undefined);
    addMetars(history.metars);
    await applySamples(history.flights);
  }

  /** Drops everything older than the relay's retention window, as the relay does. */
  function prune(): void {
    const startMs = serverNowMs() - feed.retentionMs;
    for (const [id, track] of [...tracksById]) {
      const keepFrom = track.samples.findIndex((s) => s.tMs >= startMs);
      if (keepFrom === 0) continue;
      const flight = flightsById.get(id);
      if (keepFrom < 0 || (flight && !trimFlightBefore(flight, startMs))) {
        removeFlight(id);
        continue;
      }
      track.samples.splice(0, keepFrom);
      if (flight) hooks.changed(flight);
    }
    let firstMetar = 0;
    rawMetars.forEach((m, i) => m.obsTime * 1000 <= startMs && (firstMetar = i));
    rawMetars = rawMetars.slice(firstMetar);
    ctx.metars = parseMetars(rawMetars);
    viewer.clock.startTime = JulianDate.fromDate(new Date(startMs));
  }

  // Messages are applied strictly in order, even though applying them is async.
  let chain = Promise.resolve();
  const enqueue = (apply: () => Promise<void> | void) => {
    chain = chain.then(apply).catch((err) => console.error("Live update failed", err));
  };
  feed.run((message) => {
    if (message.kind === "samples") {
      // Measured on arrival: applying an event can lag behind it.
      serverOffsetMs = message.event.now - message.receivedAtMs;
      latestEventNowMs = message.event.now;
      enqueue(() => applySamples(message.event.flights));
    } else if (message.kind === "metar") {
      enqueue(() => addMetars(message.metars));
    } else {
      enqueue(fillGap);
    }
  });
  setInterval(() => enqueue(prune), PRUNE_INTERVAL_MS);

  setUpLiveClock(viewer, feed.tracks, () => serverNowMs() - LIVE_DELAY_MS);
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
