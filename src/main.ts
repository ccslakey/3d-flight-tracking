import { Cartesian3, type Entity, Ion, JulianDate, Math as CesiumMath, Terrain, type TerrainProvider, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { createDebugTrails } from "./debugTrails";
import { createFlightList } from "./flightList";
import { loadGeoidGrid } from "./geoid";
import { parseMetars, type RawMetar } from "./metar";
import { addFlightEntity, type ReplayFlight, resolveSamples, setClockRange } from "./replay";
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

if (import.meta.env.DEV) Object.assign(window, { viewer });

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

async function loadReplay(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const geomReference = params.get("geom") === "MSL" ? "MSL" : DEFAULT_GEOM_REFERENCE;

  const manifest = await fetchJson<TrackManifest>("/data/tracks/manifest.json");
  const recording =
    manifest.recordings.find((r) => r.stamp === params.get("rec")) ?? manifest.recordings[manifest.recordings.length - 1];
  if (!recording) throw new Error("No recordings in manifest");

  const [index, rawMetars, geoid, terrainProvider] = await Promise.all([
    fetchJson<RecordingIndex>(`/data/tracks/${recording.stamp}/index.json`),
    fetchJson<RawMetar[]>(`/data/${recording.metarFile}`),
    loadGeoidGrid(),
    terrainReady,
  ]);
  const metars = parseMetars(rawMetars);
  const tracks = await Promise.all(
    index.flights.map((f) => fetchJson<TrackFile>(`/data/tracks/${recording.stamp}/${f.id}.json`)),
  );
  const tracksById = new Map(tracks.map((t) => [t.id, t]));

  const ctx = { geoid, metars, geomReference, terrainProvider } as const;
  const flights = (
    await Promise.all(tracks.map(async (t) => addFlightEntity(viewer, t, await resolveSamples(t, ctx))))
  ).filter((f) => f !== null);
  const byEntityId = new Map(flights.map((f) => [f.entity.id, f]));
  setClockRange(
    viewer,
    Math.min(...flights.map((f) => f.startMs)),
    Math.max(...flights.map((f) => f.stopMs)),
  );

  const sidePanel = document.createElement("div");
  sidePanel.className = "side-panel";
  document.body.append(sidePanel);
  const list = createFlightList(sidePanel, flights, (f) => select(f));
  const trails = createDebugTrails(viewer, sidePanel, geomReference);

  let current: ReplayFlight | null = null;
  function select(flight: ReplayFlight | null): void {
    if (flight === current) return;
    current = flight;
    if (flight && !flight.entity.isAvailable(viewer.clock.currentTime)) {
      viewer.clock.currentTime = JulianDate.fromDate(new Date(flight.startMs));
    }
    viewer.selectedEntity = flight?.entity;
    viewer.trackedEntity = flight?.entity;
    trails.show(flight ? (flight.track.flight ?? flight.track.hex) : null, flight?.resolved ?? []);
    list.setSelected(flight?.track.id ?? null);
  }
  viewer.selectedEntityChanged.addEventListener((entity?: Entity) => {
    // Clicking a debug trail selects a non-flight entity; keep the current flight then.
    if (!entity) select(null);
    else if (byEntityId.has(entity.id)) select(byEntityId.get(entity.id)!);
  });

  const requested = params.get("flight");
  if (requested) {
    const flight = flights.find((f) => f.track.id === requested);
    if (!flight) throw new Error(`Flight ${requested} not found in ${index.source}`);
    select(flight);
  }

  void addValidationPanel(index, async (id) => tracksById.get(id)!, geoid, metars, terrainProvider).catch((err) =>
    console.error(err),
  );
  console.info(`Replaying ${flights.length} flights from ${recording.stamp}`);
}

loadReplay().catch((err) => {
  console.error(err);
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = String(err instanceof Error ? err.message : err);
  document.body.append(banner);
});
