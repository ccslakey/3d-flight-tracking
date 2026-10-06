import { Cartesian3, Ion, Math as CesiumMath, Terrain, type TerrainProvider, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { addDebugTrails } from "./debugTrails";
import { loadGeoidGrid } from "./geoid";
import { parseMetars, type RawMetar } from "./metar";
import { addFlightEntity, resolveSamples } from "./replay";
import { addValidationPanel } from "./validationPanel";
import type { FlightSummary, RecordingIndex, TrackFile, TrackManifest } from "./track";

const SFO_LAT = 37.6189;
const SFO_LON = -122.375;
// Until Phase 6 settles it. Override with ?geom=MSL.
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

const viewer = new Viewer("cesiumContainer", { terrain, navigationInstructionsInitiallyVisible: false });

if (import.meta.env.DEV) Object.assign(window, { viewer });

// Hide anything below terrain so altitude errors are visible.
viewer.scene.globe.depthTestAgainstTerrain = true;

// Look at SFO from the southeast, about 8 km out.
viewer.camera.setView({
  destination: Cartesian3.fromDegrees(SFO_LON + 0.06, SFO_LAT - 0.08, 3000),
  orientation: {
    heading: CesiumMath.toRadians(-30),
    pitch: CesiumMath.toRadians(-20),
    roll: 0,
  },
});

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A landing with geom data and the most samples, or the flight named by ?flight=. */
function pickFlight(index: RecordingIndex, requestedId: string | null): FlightSummary {
  if (requestedId) {
    const flight = index.flights.find((f) => f.id === requestedId);
    if (!flight) throw new Error(`Flight ${requestedId} not found in ${index.source}`);
    return flight;
  }
  const landings = index.flights
    .filter((f) => f.landing?.method === "ground" && f.hasGeom)
    .sort((a, b) => b.sampleCount - a.sampleCount);
  if (!landings.length) throw new Error(`No landings with geom data in ${index.source}`);
  return landings[0];
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
  const loadTrack = (id: string) => fetchJson<TrackFile>(`/data/tracks/${recording.stamp}/${id}.json`);
  const flight = pickFlight(index, params.get("flight"));
  const track = await loadTrack(flight.id);

  const resolved = await resolveSamples(track, { geoid, metars, geomReference, terrainProvider });
  const entity = addFlightEntity(viewer, track, resolved);
  addDebugTrails(viewer, resolved, geomReference);
  void addValidationPanel(index, loadTrack, geoid, metars, terrainProvider).catch((err) => console.error(err));
  viewer.trackedEntity = undefined;
  await viewer.zoomTo(viewer.entities);
  console.info(`Replaying ${track.flight ?? track.hex} (${flight.id}), ${resolved.length} samples`, entity.id);
}

loadReplay().catch((err) => {
  console.error(err);
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = String(err instanceof Error ? err.message : err);
  document.body.append(banner);
});
