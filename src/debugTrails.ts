// Three polylines for the selected flight (uncorrected baro, corrected baro, geom) with a
// legend whose checkboxes toggle them. Heights come only from altitude.ts.

import { Cartesian3, Color, type Entity, PolylineDashMaterialProperty, type Viewer } from "cesium";
import { baroToEllipsoidM, geomToEllipsoidM, uncorrectedBaroToEllipsoidM } from "./altitude";
import type { ResolvedSample } from "./replay";

interface TrailSpec {
  key: string;
  label: string;
  color: Color;
  heightM: (r: ResolvedSample, geomReference: "HAE" | "MSL") => number | null;
}

const TRAILS: TrailSpec[] = [
  {
    key: "uncorrected",
    label: "Baro, uncorrected (29.92)",
    color: Color.fromCssColorString("#ff5c5c"),
    heightM: (r) => (typeof r.sample.altBaroFt === "number" ? uncorrectedBaroToEllipsoidM(r.sample.altBaroFt, r.geoidN) : null),
  },
  {
    key: "corrected",
    label: "Baro, METAR-corrected",
    color: Color.fromCssColorString("#4dd2ff"),
    heightM: (r) =>
      typeof r.sample.altBaroFt === "number" ? baroToEllipsoidM(r.sample.altBaroFt, r.altimeterInHg, r.geoidN) : null,
  },
  {
    key: "geom",
    label: "Geom",
    color: Color.fromCssColorString("#ffd84d"),
    heightM: (r, ref) => (r.sample.altGeomFt !== null ? geomToEllipsoidM(r.sample.altGeomFt, ref, r.geoidN) : null),
  },
];

export interface DebugTrails {
  /** Replaces the trails with the given flight's, or clears them when null. */
  show(flightName: string | null, resolved: ResolvedSample[]): void;
}

/** Creates the trail legend inside `container`; checkbox state persists across flights. */
export function createDebugTrails(viewer: Viewer, container: HTMLElement, geomReference: "HAE" | "MSL"): DebugTrails {
  const legend = document.createElement("div");
  legend.className = "trail-legend";
  const title = document.createElement("div");
  title.className = "trail-legend-title";
  legend.append(title);

  const visible = new Map(TRAILS.map((spec) => [spec.key, true]));
  const entities = new Map<string, Entity>();
  const rows = new Map<string, { box: HTMLInputElement; text: Text }>();

  for (const spec of TRAILS) {
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.addEventListener("change", () => {
      visible.set(spec.key, box.checked);
      const entity = entities.get(spec.key);
      if (entity) entity.show = box.checked;
    });
    const swatch = document.createElement("span");
    swatch.className = "trail-swatch";
    swatch.style.background = spec.color.toCssColorString();
    const text = document.createTextNode(` ${spec.label}`);
    row.append(box, swatch, text);
    legend.append(row);
    rows.set(spec.key, { box, text });
  }
  container.append(legend);

  function show(flightName: string | null, resolved: ResolvedSample[]): void {
    for (const entity of entities.values()) viewer.entities.remove(entity);
    entities.clear();
    title.textContent = flightName
      ? `Altitude trails: ${flightName} (geom as ${geomReference})`
      : "Altitude trails: select a flight";

    for (const spec of TRAILS) {
      const positions: Cartesian3[] = [];
      for (const r of resolved) {
        const h = spec.heightM(r, geomReference);
        if (h !== null) positions.push(Cartesian3.fromDegrees(r.sample.lon, r.sample.lat, h));
      }
      const { box, text } = rows.get(spec.key)!;
      const hasData = positions.length >= 2;
      box.disabled = !hasData;
      text.textContent = ` ${spec.label}${flightName && !hasData ? " (no data)" : ""}`;
      if (!hasData) continue;
      entities.set(
        spec.key,
        viewer.entities.add({
          show: visible.get(spec.key),
          polyline: {
            positions,
            width: 2,
            material: spec.color,
            // Show the part below terrain as dashes so altitude errors stay visible.
            depthFailMaterial: new PolylineDashMaterialProperty({ color: spec.color.withAlpha(0.6) }),
          },
        }),
      );
    }
  }

  show(null, []);
  return { show };
}
