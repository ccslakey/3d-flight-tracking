// Debug panel: residuals of every landing's last airborne sample against sampled terrain at
// the touchdown point. This checks rendering; scripts/validate-landings.ts checks the math.

import { Cartographic, sampleTerrainMostDetailed, type TerrainProvider } from "cesium";
import { metersToFeet } from "./altitude";
import type { GeoidGrid } from "./geoid";
import type { Metar } from "./metar";
import type { RecordingIndex, TrackFile } from "./track";
import { checkLanding, residualsM, SOURCES, summarizeBySource } from "./validation";

export async function addValidationPanel(
  index: RecordingIndex,
  loadTrack: (id: string) => Promise<TrackFile>,
  geoid: GeoidGrid,
  metars: Metar[],
  terrainProvider: TerrainProvider,
): Promise<void> {
  const panel = document.createElement("div");
  panel.className = "validation-panel";
  panel.textContent = "Validating landings…";
  document.body.append(panel);

  const landingIds = index.flights.filter((f) => f.landing?.method === "ground").map((f) => f.id);
  const tracks = await Promise.all(landingIds.map(loadTrack));
  const checks = tracks.map((t) => checkLanding(t, geoid, metars)).filter((c) => c !== null);

  const terrain = await sampleTerrainMostDetailed(
    terrainProvider,
    checks.map((c) => Cartographic.fromDegrees(c.touchdown.lon, c.touchdown.lat)),
  );
  const perLanding = checks.flatMap((c, i) => {
    const h = terrain[i].height;
    return Number.isFinite(h) ? [residualsM(c, h)] : [];
  });
  const bySource = summarizeBySource(perLanding);

  const fmt = (m: number, signed: boolean) =>
    `${signed && m >= 0 ? "+" : ""}${metersToFeet(m).toFixed(0)} ft`;
  const rows = SOURCES.map((source) => {
    const s = bySource[source];
    return s
      ? `<tr><td>${source}</td><td>${s.count}</td><td>${fmt(s.medianM, true)}</td><td>${fmt(s.p95AbsM, false)}</td><td>${fmt(s.maxAbsM, false)}</td></tr>`
      : `<tr><td>${source}</td><td>0</td><td colspan="3">no data</td></tr>`;
  }).join("");

  panel.innerHTML = `
    <div class="validation-title">Touchdown vs terrain (${perLanding.length} landings)</div>
    <table>
      <thead><tr><th>Source</th><th>n</th><th>Median</th><th>p95 |res|</th><th>Max |res|</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="validation-note">Last airborne sample minus terrain height at the first "ground" position.</div>`;
}
