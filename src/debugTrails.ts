// Three polylines for one flight (uncorrected baro, corrected baro, geom) with a legend
// whose checkboxes toggle them. Heights come only from altitude.ts.

import { Cartesian3, Color, PolylineDashMaterialProperty, type Viewer } from "cesium";
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

export function addDebugTrails(viewer: Viewer, resolved: ResolvedSample[], geomReference: "HAE" | "MSL"): void {
  const legend = document.createElement("div");
  legend.className = "trail-legend";
  legend.innerHTML = `<div class="trail-legend-title">Altitude trails (geom as ${geomReference})</div>`;

  for (const spec of TRAILS) {
    const positions: Cartesian3[] = [];
    for (const r of resolved) {
      const h = spec.heightM(r, geomReference);
      if (h !== null) positions.push(Cartesian3.fromDegrees(r.sample.lon, r.sample.lat, h));
    }
    const entity = viewer.entities.add({
      id: `trail-${spec.key}`,
      polyline: {
        positions,
        width: 2,
        material: spec.color,
        // Show the part below terrain as dashes so altitude errors stay visible.
        depthFailMaterial: new PolylineDashMaterialProperty({ color: spec.color.withAlpha(0.6) }),
      },
    });

    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.disabled = positions.length < 2;
    box.addEventListener("change", () => (entity.show = box.checked));
    const swatch = document.createElement("span");
    swatch.className = "trail-swatch";
    swatch.style.background = spec.color.toCssColorString();
    row.append(box, swatch, ` ${spec.label}${positions.length < 2 ? " (no data)" : ""}`);
    legend.append(row);
  }
  document.body.append(legend);
}
