// Live mode: one continuous timeline from the start of the relay's archive to a live edge a
// little behind the latest data, so every aircraft has a next sample to move toward. Only a
// few hours around the clock are loaded (see liveWindow.ts); scrubbing or jumping elsewhere
// loads that part of the archive and drops what is far away. While the loaded window reaches
// the live edge, each poll's samples stream in and are added as they arrive.

import { ClockRange, JulianDate, type Viewer } from "cesium";
import { parseMetars, type RawMetar } from "./metar";
import { type FetchRange, type LoadWindow, missingRanges, nextWindow, overlaps } from "./liveWindow";
import { addFlightEntity, mergeResolved, type ReplayContext, type ReplayFlight, resolveSampleGroups } from "./replay";
import type { ArchiveInfo, LiveFlightSamples, LiveHistory, LiveSamplesEvent, TrackFile, TrackSample } from "./track";

const LIVE_DELAY_MS = 15_000;
// Polls rate-limited by adsb.lol leave gaps longer than the delay. Holding each aircraft at its
// last position this long keeps the whole sky from blinking out until the next poll.
export const LIVE_HOLD_MS = 30_000;
const RESUME_WITHIN_S = 1; // reaching this close to the live edge resumes following
const TIMELINE_REZOOM_MS = 60_000;
const WINDOW_CHECK_MS = 500;
const ARCHIVE_REFRESH_MS = 10 * 60_000;
const INITIAL_LIVE_MS = 60 * 60_000; // loaded behind the live edge on startup
// Gap fill starts this far before the last data seen, since positions arrive up to 15 s old.
const GAP_FILL_MARGIN_MS = 60_000;
const RECONNECT_MS = 3_000;
const STALE_STREAM_MS = 40_000; // the relay pings every 15 s

/** Live input in arrival order. `reconnected` marks a dropped stream coming back. */
export type LiveMessage =
  | { kind: "samples"; event: LiveSamplesEvent; receivedAtMs: number }
  | { kind: "metar"; metars: RawMetar[] }
  | { kind: "reconnected" };

export interface LiveFeed {
  tracks: TrackFile[];
  rawMetars: RawMetar[];
  archive: ArchiveInfo;
  /** The span `tracks` covers. */
  window: LoadWindow;
  /** Starts delivering messages, beginning with any that arrived while history loaded. */
  run(handler: (message: LiveMessage) => void): void;
  /** Whether the event stream is open, and when the page last heard from it. */
  stream(): { open: boolean; lastHeardMs: number };
}

/** Controls for the running live view. */
export interface LiveView {
  /** Moves the clock to a time in the archive, loading it if needed. */
  jumpTo(ms: number): void;
  goLive(): void;
  /** Whether the clock is following the live edge. */
  following(): boolean;
  /** The span being loaded right now, if any. */
  loading(): FetchRange | null;
}

async function relayJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Live relay unavailable (HTTP ${res.status}). Start it with npm run relay.`);
  return (await res.json()) as T;
}

const fetchHistory = ({ fromMs, toMs }: FetchRange) =>
  relayJson<LiveHistory>(`/api/history?from=${Math.floor(fromMs)}${toMs === null ? "" : `&to=${Math.ceil(toMs)}`}`);

export const fetchArchive = () => relayJson<ArchiveInfo>("/api/archive");

/**
 * Subscribes to live events first, then loads history, so nothing is missed in between. With
 * `startAtMs`, loads the archive around that time instead of the latest hour. Fails before
 * subscribing if the relay is unreachable.
 */
export async function connectLive(startAtMs?: number): Promise<LiveFeed> {
  const archive = await fetchArchive();
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

  const nowMs = Date.now();
  const window: LoadWindow =
    startAtMs === undefined
      ? { fromMs: nowMs - INITIAL_LIVE_MS, toMs: nowMs, attached: true }
      : (nextWindow({ fromMs: nowMs, toMs: nowMs, attached: true }, startAtMs, nowMs - LIVE_DELAY_MS, archive.startMs ?? nowMs) ?? {
          fromMs: nowMs - INITIAL_LIVE_MS,
          toMs: nowMs,
          attached: true,
        });
  const history = await fetchHistory({ fromMs: window.fromMs, toMs: window.attached ? null : window.toMs });
  return {
    tracks: history.flights,
    rawMetars: history.metars,
    archive,
    window,
    run(handler) {
      deliver = handler;
      for (const message of queued.splice(0)) handler(message);
    },
    stream: () => ({ open: source.readyState === EventSource.OPEN, lastHeardMs }),
  };
}

export interface LiveHooks {
  added(flight: ReplayFlight): void;
  /** Samples were added. */
  changed(flight: ReplayFlight): void;
  /** Its entity is already removed from the viewer. */
  removed(flight: ReplayFlight): void;
}

/** Applies live events and archive loads to the scene, and runs the live-edge clock. */
export function runLive(
  viewer: Viewer,
  ctx: ReplayContext,
  feed: LiveFeed,
  flights: ReplayFlight[],
  hooks: LiveHooks,
  startAtMs?: number,
): LiveView {
  const tracksById = new Map(feed.tracks.map((t) => [t.id, t]));
  const flightsById = new Map(flights.map((f) => [f.track.id, f]));
  let rawMetars = [...feed.rawMetars];
  let archive = feed.archive;
  let win = feed.window;
  let loading: FetchRange | null = null;
  // Relay data time minus local time, so the viewer's clock offset does not matter.
  let serverOffsetMs = 0;
  let latestEventNowMs: number | null = null;
  const serverNowMs = () => Date.now() + serverOffsetMs;
  const liveEdgeMs = () => serverNowMs() - LIVE_DELAY_MS;
  const toJulian = (ms: number) => JulianDate.fromDate(new Date(ms));
  const clockMs = () => JulianDate.toDate(viewer.clock.currentTime).getTime();

  function removeFlight(id: string): void {
    tracksById.delete(id);
    const flight = flightsById.get(id);
    if (!flight) return;
    flightsById.delete(id);
    viewer.entities.remove(flight.entity);
    hooks.removed(flight);
  }

  /** Adds flights and samples not held yet. The same flight can arrive from live events and archive loads. */
  async function mergeTracks(updates: (LiveFlightSamples & { landing?: TrackFile["landing"] })[]): Promise<void> {
    const fresh: { track: TrackFile; samples: TrackSample[] }[] = [];
    for (const update of updates) {
      let track = tracksById.get(update.id);
      if (!track) tracksById.set(update.id, (track = { id: update.id, hex: update.hex, landing: null, samples: [] }));
      track.flight ??= update.flight;
      track.typeCode ??= update.typeCode;
      track.landing = update.landing ?? track.landing;
      const known = new Set(track.samples.map((s) => s.tMs));
      const samples = update.samples.filter((s) => !known.has(s.tMs));
      if (!samples.length) continue;
      track.samples = [...track.samples, ...samples].sort((a, b) => a.tMs - b.tMs);
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
        mergeResolved(flight, resolved[i]);
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
    rawMetars = [...rawMetars, ...added].sort((a, b) => a.obsTime - b.obsTime);
    ctx.metars = parseMetars(rawMetars);
  }

  /** Moves to a new window: drops flights outside it, then fetches what it adds. */
  async function loadWindow(next: LoadWindow): Promise<void> {
    const ranges = missingRanges(win, next, liveEdgeMs());
    win = next;
    for (const [id, track] of [...tracksById]) {
      const startMs = track.samples[0]?.tMs ?? -Infinity;
      const stopMs = (track.samples[track.samples.length - 1]?.tMs ?? -Infinity) + LIVE_HOLD_MS;
      if (!overlaps(win, startMs, stopMs)) removeFlight(id);
    }
    for (const range of ranges) {
      loading = range;
      try {
        const history = await fetchHistory(range);
        addMetars(history.metars);
        await mergeTracks(history.flights);
      } catch (err) {
        // Shrink the window to exclude this range, so the next check fetches it again.
        win =
          range.fromMs === next.fromMs && range.toMs !== null
            ? { ...next, fromMs: range.toMs }
            : { ...next, toMs: range.fromMs, attached: false };
        throw err;
      } finally {
        loading = null;
      }
    }
  }

  /** Fetches what the relay received while the stream was down. Overlap is dropped by sample time. */
  async function fillGap(): Promise<void> {
    if (!win.attached) return;
    const lastSampleMs = Math.max(...[...tracksById.values()].map((t) => t.samples[t.samples.length - 1]?.tMs ?? -Infinity));
    const fromMs = (latestEventNowMs ?? lastSampleMs) - GAP_FILL_MARGIN_MS;
    const history = await fetchHistory({ fromMs: Number.isFinite(fromMs) ? fromMs : liveEdgeMs() - INITIAL_LIVE_MS, toMs: null });
    addMetars(history.metars);
    await mergeTracks(history.flights);
  }

  // Messages and loads are applied strictly in order, even though applying them is async.
  let chain = Promise.resolve();
  let pending = 0;
  const enqueue = (apply: () => Promise<void> | void) => {
    pending++;
    chain = chain
      .then(apply)
      .catch((err) => console.error("Live update failed", err))
      .finally(() => pending--);
  };
  feed.run((message) => {
    if (message.kind === "samples") {
      // Measured on arrival: applying an event can lag behind it.
      serverOffsetMs = message.event.now - message.receivedAtMs;
      latestEventNowMs = message.event.now;
      // A detached window ignores live data; attaching fetches what it missed.
      enqueue(() => (win.attached ? mergeTracks(message.event.flights) : undefined));
    } else if (message.kind === "metar") {
      enqueue(() => addMetars(message.metars));
    } else {
      enqueue(fillGap);
    }
  });

  // Loads whatever the clock needs, one window at a time.
  let checking = false;
  setInterval(() => {
    if (checking || pending > 0) return;
    const next = nextWindow(win, clockMs(), liveEdgeMs(), archive.startMs ?? win.fromMs);
    if (!next) return;
    checking = true;
    const jumped = !overlaps(win, next.fromMs, next.attached ? Infinity : next.toMs);
    enqueue(async () => {
      try {
        await loadWindow(next);
        if (jumped) zoomTimeline();
      } finally {
        checking = false;
      }
    });
  }, WINDOW_CHECK_MS);

  setInterval(async () => {
    try {
      archive = await fetchArchive();
      if (archive.startMs !== null) viewer.clock.startTime = toJulian(archive.startMs);
    } catch (err) {
      console.error("Archive refresh failed", err);
    }
  }, ARCHIVE_REFRESH_MS);

  // Clock and timeline.
  const { clock, timeline } = viewer;
  clock.startTime = toJulian(Math.min(archive.startMs ?? Infinity, win.fromMs));
  clock.stopTime = toJulian(liveEdgeMs());
  clock.currentTime = startAtMs === undefined ? clock.stopTime.clone() : toJulian(startAtMs);
  // Clamped by hand below: with CLAMPED, the animation widget pauses whenever the time equals the stop time.
  clock.clockRange = ClockRange.UNBOUNDED;
  clock.multiplier = 1;
  clock.shouldAnimate = true;
  // The timeline shows the loaded window; zooming out reaches the rest of the archive.
  const zoomTimeline = () => timeline.zoomTo(toJulian(win.fromMs), toJulian(win.attached ? liveEdgeMs() : win.toMs));
  zoomTimeline();

  const button = document.createElement("button");
  button.className = "live-button";
  button.textContent = "LIVE";
  button.title = "Jump to live";
  document.body.append(button);

  let following = startAtMs === undefined;
  const setFollowing = (on: boolean) => {
    following = on;
    if (on) clock.multiplier = 1;
    button.classList.toggle("is-live", on);
  };
  setFollowing(following);
  setInterval(() => following && zoomTimeline(), TIMELINE_REZOOM_MS);

  const goLive = () => {
    clock.shouldAnimate = true;
    setFollowing(true);
  };
  button.addEventListener("click", goLive);
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

  return {
    jumpTo(ms) {
      setFollowing(false);
      clock.currentTime = toJulian(Math.max(ms, archive.startMs ?? ms));
    },
    goLive,
    following: () => following,
    loading: () => loading,
  };
}
