// Keyboard camera controls, applied every frame while keys are held:
//   W/A/S/D  pan forward/left/back/right along the ground
//   R/F      zoom in/out
//   Q/E      rotate the view left/right
//   X/C      tilt toward overhead / toward the horizon
// Rotation and tilt orbit the ground point at the center of the screen, or the tracked
// aircraft while one is followed. Panning stops following it.

import { Cartesian2, Cartesian3, Math as CesiumMath, Matrix4, Transforms, type Viewer } from "cesium";

const PAN_HEIGHTS_PER_S = 0.8; // pan speed as a multiple of camera height
const ZOOM_PER_S = 0.8; // fraction of the distance to the target covered per second
const ROTATE_RAD_PER_S = CesiumMath.toRadians(60);
const TILT_RAD_PER_S = CesiumMath.toRadians(45);
const MIN_PITCH = CesiumMath.toRadians(-90);
const MAX_PITCH = CesiumMath.toRadians(-5); // keep the view above the horizon
const MIN_HEIGHT_M = 30;

const KEYS = new Set(["w", "a", "s", "d", "r", "f", "q", "e", "x", "c"]);

/** True when a key press belongs to a text field or a browser/OS shortcut, not to the app. */
export const isNotForShortcuts = (e: KeyboardEvent): boolean =>
  e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && !!e.target.closest("input, textarea, select"));

export function enableKeyboardCamera(viewer: Viewer): void {
  const { scene, camera } = viewer;
  const held = new Set<string>();

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (!KEYS.has(key) || isNotForShortcuts(e)) return;
    held.add(key);
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => held.clear());

  /** Ground point at the center of the screen, if the view hits the globe. */
  function centerPoint(): Cartesian3 | undefined {
    const canvas = scene.canvas;
    const ray = camera.getPickRay(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    return (ray && scene.globe.pick(ray, scene)) ?? camera.pickEllipsoid(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  }

  /** Runs `move` with the camera in a frame centered on `pivot`, then restores the world frame. */
  function aroundPivot(move: () => void): void {
    if (viewer.trackedEntity) return move(); // already in the aircraft's frame
    const pivot = centerPoint();
    if (!pivot) return;
    camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(pivot));
    move();
    camera.lookAtTransform(Matrix4.IDENTITY);
  }

  function pan(forward: number, right: number, dt: number): void {
    viewer.trackedEntity = undefined;
    const height = Math.max(camera.positionCartographic.height, MIN_HEIGHT_M);
    const enu = Transforms.eastNorthUpToFixedFrame(camera.positionWC);
    const h = camera.heading;
    // Forward and right along the ground, in east/north components.
    const east = forward * Math.sin(h) + right * Math.cos(h);
    const north = forward * Math.cos(h) - right * Math.sin(h);
    const direction = Matrix4.multiplyByPointAsVector(enu, new Cartesian3(east, north, 0), new Cartesian3());
    Cartesian3.normalize(direction, direction);
    camera.move(direction, height * PAN_HEIGHTS_PER_S * dt);
  }

  function zoom(sign: number, dt: number): void {
    if (viewer.trackedEntity) {
      camera.zoomIn(sign * camera.getMagnitude() * ZOOM_PER_S * dt);
      return;
    }
    const target = centerPoint();
    const distance = target ? Cartesian3.distance(camera.positionWC, target) : camera.positionCartographic.height;
    if (sign > 0 && camera.positionCartographic.height <= MIN_HEIGHT_M) return;
    camera.moveForward(sign * Math.max(distance, MIN_HEIGHT_M) * ZOOM_PER_S * dt);
  }

  function tilt(sign: number, dt: number): void {
    // Positive sign tilts toward overhead (pitch toward -90°).
    const step = sign * TILT_RAD_PER_S * dt;
    const target = CesiumMath.clamp(camera.pitch - step, MIN_PITCH, MAX_PITCH);
    const delta = camera.pitch - target;
    if (Math.abs(delta) < 1e-6) return;
    aroundPivot(() => camera.rotateUp(-delta));
  }

  let lastMs = performance.now();
  scene.preRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min((now - lastMs) / 1000, 0.1); // cap after a stall so the camera doesn't jump
    lastMs = now;
    if (!held.size) return;

    const forward = (held.has("w") ? 1 : 0) - (held.has("s") ? 1 : 0);
    const right = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
    if (forward || right) pan(forward, right, dt);

    const zoomSign = (held.has("r") ? 1 : 0) - (held.has("f") ? 1 : 0);
    if (zoomSign) zoom(zoomSign, dt);

    // rotateLeft orbits the camera left around the pivot, which turns the view to the right.
    const turnRight = (held.has("e") ? 1 : 0) - (held.has("q") ? 1 : 0);
    if (turnRight) aroundPivot(() => camera.rotateLeft(turnRight * ROTATE_RAD_PER_S * dt));

    const tiltSign = (held.has("x") ? 1 : 0) - (held.has("c") ? 1 : 0);
    if (tiltSign) tilt(tiltSign, dt);
  });
}
