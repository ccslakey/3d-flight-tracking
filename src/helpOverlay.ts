// Overlay listing the keyboard shortcuts. Opened from a toolbar button or with "?", closed
// with Escape, a click outside it, or the button again.

import type { Viewer } from "cesium";
import { isNotForShortcuts } from "./keyboardCamera";

const SECTIONS: { title: string; rows: [keys: string[], action: string][] }[] = [
  {
    title: "Camera",
    rows: [
      [["W", "A", "S", "D"], "Pan forward, left, back, right"],
      [["R", "F"], "Zoom in, out"],
      [["Q", "E"], "Turn view left, right"],
      [["X", "C"], "Tilt toward overhead, horizon"],
    ],
  },
  {
    title: "Playback",
    rows: [
      [["Space"], "Pause, resume"],
      [["←", "→"], "Step between rewind, pause, play"],
      [["↑", "↓"], "Faster, slower"],
    ],
  },
  {
    title: "Help",
    rows: [
      [["?"], "Show or hide this list"],
      [["Esc"], "Close"],
    ],
  },
];

const NOTE =
  "Turning, tilting, and zooming orbit the center of the screen, or the followed aircraft. Panning stops following it.";

export function createHelpOverlay(viewer: Viewer): void {
  const overlay = document.createElement("div");
  overlay.className = "help-overlay";
  overlay.hidden = true;

  const panel = document.createElement("div");
  panel.className = "help-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Keyboard shortcuts");
  const heading = document.createElement("div");
  heading.className = "help-title";
  heading.textContent = "Keyboard shortcuts";
  panel.append(heading);

  for (const section of SECTIONS) {
    const title = document.createElement("div");
    title.className = "help-section";
    title.textContent = section.title;
    const table = document.createElement("div");
    table.className = "help-rows";
    for (const [keys, action] of section.rows) {
      const keyCell = document.createElement("span");
      keyCell.append(
        ...keys.map((k) => {
          const kbd = document.createElement("kbd");
          kbd.textContent = k;
          return kbd;
        }),
      );
      const actionCell = document.createElement("span");
      actionCell.textContent = action;
      table.append(keyCell, actionCell);
    }
    panel.append(title, table);
  }
  const note = document.createElement("div");
  note.className = "help-note";
  note.textContent = NOTE;
  panel.append(note);
  overlay.append(panel);
  document.body.append(overlay);

  // Matches Cesium's own toolbar buttons.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cesium-button cesium-toolbar-button help-button";
  button.title = "Keyboard shortcuts (?)";
  button.setAttribute("aria-label", "Keyboard shortcuts");
  // A keyboard: outline, two rows of keys, and a space bar, sized like Cesium's icons.
  button.innerHTML = `<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
    <rect x="3" y="8" width="26" height="16" rx="2.5" fill="none" stroke="#fff" stroke-width="2"/>
    <g fill="#fff">
      <rect x="7" y="12" width="3" height="3" rx=".5"/><rect x="12" y="12" width="3" height="3" rx=".5"/>
      <rect x="17" y="12" width="3" height="3" rx=".5"/><rect x="22" y="12" width="3" height="3" rx=".5"/>
      <rect x="10" y="18" width="12" height="2.5" rx=".5"/>
    </g>
  </svg>`;
  const toolbar = viewer.container.querySelector(".cesium-viewer-toolbar");
  toolbar?.insertBefore(button, toolbar.querySelector(".cesium-navigationHelpButton-wrapper"));

  let isOpen = false;
  const setOpen = (open: boolean) => {
    isOpen = open;
    overlay.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", () => setOpen(!isOpen));
  overlay.addEventListener("click", (e) => e.target === overlay && setOpen(false));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) setOpen(false);
    else if (e.key === "?" && !isNotForShortcuts(e)) setOpen(!isOpen);
  });
}
