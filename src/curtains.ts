// Altitude curtains: a translucent wall under the selected flight's whole track, and a drop
// line under every aircraft. Both reach down to sea level (MSL 0, i.e. height N); where
// terrain is higher, depth testing hides the part below ground.

import { CallbackProperty, Cartesian3, Cartographic, Color, type Entity, Math as CesiumMath, type Viewer } from "cesium";
import { geoidUndulationM, type GeoidGrid } from "./geoid";
import type { ReplayFlight } from "./replay";

const CURTAIN_COLOR = Color.fromCssColorString("#4dd2ff");

export interface Curtains {
  /** Shows the curtain for this flight, or removes it when null. */
  show(flight: ReplayFlight | null): void;
  /** Adds a drop line for a flight created after setup. */
  add(flight: ReplayFlight): void;
}

export function createCurtains(viewer: Viewer, container: HTMLElement, flights: ReplayFlight[], geoid: GeoidGrid): Curtains {
  // Drop lines share a parent so one toggle hides them all.
  const dropLines = viewer.entities.add({ id: "drop-lines" });
  const scratch = new Cartographic();
  function add(flight: ReplayFlight): void {
    const { entity } = flight;
    viewer.entities.add({
      id: `drop-${flight.track.id}`,
      parent: dropLines,
      availability: entity.availability,
      polyline: {
        positions: new CallbackProperty((time) => {
          const top = entity.position?.getValue(time!);
          if (!top) return [];
          const c = Cartographic.fromCartesian(top, undefined, scratch);
          const seaLevelM = geoidUndulationM(geoid, CesiumMath.toDegrees(c.latitude), CesiumMath.toDegrees(c.longitude));
          return [top, Cartesian3.fromRadians(c.longitude, c.latitude, seaLevelM)];
        }, false),
        width: 1,
        material: Color.WHITE.withAlpha(0.35),
      },
    });
  }
  flights.forEach(add);

  let curtainsOn = true;
  let curtain: Entity | undefined;
  let current: ReplayFlight | null = null;

  function show(flight: ReplayFlight | null): void {
    current = flight;
    if (curtain) viewer.entities.remove(curtain);
    curtain = undefined;
    if (!flight || !curtainsOn) return;
    const points = flight.resolved.filter((r) => r.heightM !== null);
    curtain = viewer.entities.add({
      wall: {
        positions: points.map((r) => Cartesian3.fromDegrees(r.sample.lon, r.sample.lat, r.heightM!)),
        minimumHeights: points.map((r) => r.geoidN),
        material: CURTAIN_COLOR.withAlpha(0.18),
        outline: false,
      },
    });
  }

  const section = document.createElement("div");
  section.className = "trail-legend";
  section.innerHTML = `<div class="trail-legend-title">Display</div>`;
  const toggle = (label: string, checked: boolean, onChange: (on: boolean) => void) => {
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    row.append(box, ` ${label}`);
    section.append(row);
  };
  toggle("Curtain under selected flight", curtainsOn, (on) => {
    curtainsOn = on;
    show(current);
  });
  toggle("Drop lines to sea level", dropLines.show, (on) => (dropLines.show = on));
  container.append(section);

  return { show, add };
}
