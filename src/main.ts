import { Cartesian3, Credit, type Entity, Ion, JulianDate, Math as CesiumMath, Terrain, type TerrainProvider, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { createConnectionPanel } from "./connectionPanel";
import { createCurtains } from "./curtains";
import { createDebugTrails } from "./debugTrails";
import { createFlightList } from "./flightList";
import { createHelpOverlay } from "./helpOverlay";
import { enableKeyboardCamera } from "./keyboardCamera";
import { enableKeyboardTime } from "./keyboardTime";
import { loadGeoidGrid } from "./geoid";
import { parseMetars, type RawMetar } from "./metar";
import { connectLive, fetchArchive, LIVE_HOLD_MS, type LiveView, runLive } from "./live";
import { addFlightEntity, type ReplayContext, type ReplayFlight, resolveSampleGroups, setClockRange } from "./replay";
import { createSourcePicker, type SourcePickerHandlers } from "./sourcePicker";
import { addValidationPanel } from "./validationPanel";
import type { RecordingIndex, TrackFile, TrackManifest } from "./track";

const SFO_LAT = 37.6189;
const SFO_LON = -122.375;
// Phase 6 found 41 of 43 SFO landings HAE-referenced. Override with ?geom=MSL.
const DEFAULT_GEOM_REFERENCE = "HAE";

const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (!ionToken) {
  throw new Error("VITE_CESIUM_ION_TOKEN is not set. Add it to .env.");
}
Ion.defaultAccessToken = ionToken;

const terrain = Terrain.fromWorldTerrain();
const terrainReady = new Promise<TerrainProvider>((resolve, reject) => {
  terrain.readyEvent.addEventListener(resolve);
  terrain.errorEvent.addEventListener(reject);
});

const viewer = new Viewer("cesiumContainer", { terrain, infoBox: false, navigationInstructionsInitiallyVisible: false });
viewer.creditDisplay.addStaticCredit(
  new Credit(
    'ADS-B data <a href="https://adsb.lol" target="_blank">adsb.lol</a> (<a href="https://opendatacommons.org/licenses/odbl/" target="_blank">ODbL</a>), weather <a href="https://aviationweather.gov" target="_blank">NOAA AWC</a>',
    true,
  ),
);

if (import.meta.env.DEV) Object.assign(window, { viewer });

enableKeyboardCamera(viewer);
enableKeyboardTime(viewer);
createHelpOverlay(viewer);

// Hide anything below terrain so altitude errors are visible.
viewer.scene.globe.depthTestAgainstTerrain = true;

// Overview of the Bay Area from the south, centered near SFO.
viewer.camera.setView({
  destination: Cartesian3.fromDegrees(SFO_LON, SFO_LAT - 0.45, 40_000),
  orientation: {
    heading: 0,
    pitch: CesiumMath.toRadians(-40),
    roll: 0,
  },
});

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface Recording {
  stamp: string;
  tracks: TrackFile[];
  rawMetars: RawMetar[];
  index: RecordingIndex;
}

const fetchManifest = () => fetchJson<TrackManifest>("/data/tracks/manifest.json");

async function loadRecording(manifest: TrackManifest, stamp: string | null): Promise<Recording> {
  const recording = manifest.recordings.find((r) => r.stamp === stamp) ?? manifest.recordings[manifest.recordings.length - 1];
  if (!recording) throw new Error("No recordings in manifest");
  const [index, rawMetars] = await Promise.all([
    fetchJson<RecordingIndex>(`/data/tracks/${recording.stamp}/index.json`),
    fetchJson<RawMetar[]>(`/data/${recording.metarFile}`),
  ]);
  const tracks = await Promise.all(
    index.flights.map((f) => fetchJson<TrackFile>(`/data/tracks/${recording.stamp}/${f.id}.json`)),
  );
  return { stamp: recording.stamp, tracks, rawMetars, index };
}

async function loadReplay(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const geomReference = params.get("geom") === "MSL" ? "MSL" : DEFAULT_GEOM_REFERENCE;
  // Live (the default) shows the relay's archive up to now, starting at ?t=<ms> if given.
  // ?rec=<stamp> plays a static recording, as does the default when the relay is down.
  const rec = params.get("rec");
  const startAtMs = params.has("t") ? Number(params.get("t")) : undefined;
  const manifestReady = fetchManifest().catch(() => null);
  const liveFeed =
    rec === null
      ? await connectLive(startAtMs).catch((err: Error) => {
          if (params.has("live") || startAtMs !== undefined) throw err;
          console.warn(`Showing the latest recording: ${err.message}`);
          return null;
        })
      : null;
  const live = liveFeed !== null;
  const loadStatic = async () => {
    const manifest = await manifestReady;
    if (!manifest) throw new Error("No recordings found");
    return loadRecording(manifest, rec);
  };

  const [source, geoid, terrainProvider, manifest] = await Promise.all([
    liveFeed ?? loadStatic(),
    loadGeoidGrid(),
    terrainReady,
    manifestReady,
  ]);
  const ctx: ReplayContext = { geoid, metars: parseMetars(source.rawMetars), geomReference, terrainProvider };
  const resolved = await resolveSampleGroups(
    source.tracks.map((t) => t.samples),
    ctx,
  );
  const flights = source.tracks
    .map((t, i) => addFlightEntity(viewer, t, resolved[i], geoid, live ? LIVE_HOLD_MS : 0))
    .filter((f) => f !== null);
  const byEntityId = new Map(flights.map((f) => [f.entity.id, f]));

  const sidePanel = document.createElement("div");
  sidePanel.className = "side-panel";
  document.body.append(sidePanel);

  let view: LiveView | null = null;
  const navigate = (search: string) => (location.search = search);
  const handlers: SourcePickerHandlers = {
    live: () => (view ? (view.goLive(), history.replaceState(null, "", location.pathname)) : navigate("")),
    archive: (ms) => (view ? (view.jumpTo(ms), history.replaceState(null, "", `?t=${ms}`)) : navigate(`?t=${ms}`)),
    recording: (stamp) => navigate(`?rec=${stamp}`),
  };
  const relayUp = live || (await fetchArchive().then(() => true, () => false));
  const picker = createSourcePicker(sidePanel, relayUp ? fetchArchive : null, manifest, handlers);
  const list = createFlightList(sidePanel, flights, (f) => select(f));
  const trails = createDebugTrails(viewer, sidePanel, geomReference);
  const curtains = createCurtains(viewer, sidePanel, flights, geoid);

  let current: ReplayFlight | null = null;
  function select(flight: ReplayFlight | null): void {
    if (flight === current) return;
    current = flight;
    if (flight && !flight.entity.isAvailable(viewer.clock.currentTime)) {
      viewer.clock.currentTime = JulianDate.fromDate(new Date(flight.startMs));
    }
    viewer.selectedEntity = flight?.entity;
    viewer.trackedEntity = flight?.entity;
    showDetails(flight);
    list.setSelected(flight?.track.id ?? null);
  }
  function showDetails(flight: ReplayFlight | null): void {
    trails.show(flight ? (flight.track.flight ?? flight.track.hex) : null, flight?.resolved ?? []);
    curtains.show(flight);
  }
  viewer.selectedEntityChanged.addEventListener((entity?: Entity) => {
    if (!entity) return select(null);
    // A drop line selects its aircraft; trails and curtains keep the current flight.
    const flight = byEntityId.get(entity.id.replace(/^drop-/, "flight-"));
    if (flight) select(flight);
    if (viewer.selectedEntity !== current?.entity) viewer.selectedEntity = current?.entity;
  });

  if ("index" in source) {
    picker.setCurrent({ kind: "recording", stamp: source.stamp });
    setClockRange(
      viewer,
      Math.min(...flights.map((f) => f.startMs)),
      Math.max(...flights.map((f) => f.stopMs)),
    );
    const tracksById = new Map(source.tracks.map((t) => [t.id, t]));
    void addValidationPanel(source.index, async (id) => tracksById.get(id)!, geoid, ctx.metars, terrainProvider).catch(
      (err) => console.error(err),
    );
  } else {
    view = runLive(viewer, ctx, source, flights, {
      added(flight) {
        byEntityId.set(flight.entity.id, flight);
        list.add(flight);
        curtains.add(flight);
      },
      changed(flight) {
        if (flight === current) showDetails(flight);
      },
      removed(flight) {
        if (flight === current) select(null);
        byEntityId.delete(flight.entity.id);
        list.remove(flight);
        curtains.remove(flight);
      },
    }, startAtMs);
    createConnectionPanel(source, view);
    const liveView = view;
    const showCurrent = () =>
      picker.setCurrent(
        liveView.following() ? { kind: "live" } : { kind: "archive", ms: JulianDate.toDate(viewer.clock.currentTime).getTime() },
      );
    showCurrent();
    setInterval(showCurrent, 1_000);
  }

  const requested = params.get("flight");
  if (requested) {
    const flight = flights.find((f) => f.track.id === requested);
    if (!flight) throw new Error(`Flight ${requested} not found`);
    select(flight);
  }
  console.info(`${live ? "Live" : "Replaying"}: ${flights.length} flights`);
}

loadReplay().catch((err) => {
  console.error(err);
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = String(err instanceof Error ? err.message : err);
  document.body.append(banner);
});
