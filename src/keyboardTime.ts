// Keyboard playback controls:
//   Space        pause / resume
//   Left/Right   step between rewind, pause, and play
//   Up/Down      next faster / slower speed, keeping the direction
// In live mode, rewinding, pausing, or speeding up leaves the live edge as the mouse
// controls do; the LIVE button returns to it.

import type { Viewer } from "cesium";
import { isNotForShortcuts } from "./keyboardCamera";

const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 200, 500];

type Mode = "rewind" | "pause" | "play";
const MODES: Mode[] = ["rewind", "pause", "play"];

export function enableKeyboardTime(viewer: Viewer): void {
  const { clock } = viewer;
  const mode = (): Mode => (!clock.shouldAnimate ? "pause" : clock.multiplier < 0 ? "rewind" : "play");
  const speed = () => Math.abs(clock.multiplier) || 1;

  function setMode(next: Mode): void {
    if (next === "pause") {
      clock.shouldAnimate = false;
      return;
    }
    clock.multiplier = next === "rewind" ? -speed() : speed();
    clock.shouldAnimate = true;
  }

  function stepSpeed(direction: 1 | -1): void {
    const current = speed();
    const next =
      direction > 0 ? (SPEEDS.find((s) => s > current) ?? SPEEDS[SPEEDS.length - 1]) : ([...SPEEDS].reverse().find((s) => s < current) ?? SPEEDS[0]);
    clock.multiplier = Math.sign(clock.multiplier || 1) * next;
  }

  window.addEventListener("keydown", (e) => {
    if (isNotForShortcuts(e)) return;
    switch (e.key) {
      case " ":
        if (!e.repeat) setMode(mode() === "pause" ? "play" : "pause");
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        if (e.repeat) break;
        const i = MODES.indexOf(mode()) + (e.key === "ArrowRight" ? 1 : -1);
        setMode(MODES[Math.max(0, Math.min(MODES.length - 1, i))]);
        break;
      }
      case "ArrowUp":
        stepSpeed(1);
        break;
      case "ArrowDown":
        stepSpeed(-1);
        break;
      default:
        return;
    }
    // Keeps Space from also pressing a focused button and arrows from scrolling.
    e.preventDefault();
  });
}
