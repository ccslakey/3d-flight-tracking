// Chooses what to show: live traffic, an hour of the relay's archive, or a static recording.
// The first menu picks Live, an archive day (UTC), or a recording; an archive day opens a
// second menu of its hours.

import type { ArchiveHour, ArchiveInfo, TrackManifest } from "./track";

const DAY_MS = 86_400_000;
const REFRESH_MS = 5 * 60_000;

export interface SourcePickerHandlers {
  live(): void;
  archive(ms: number): void;
  recording(stamp: string): void;
}

export interface SourcePicker {
  /** Shows what is on screen: live, an archive time, or a recording. */
  setCurrent(current: { kind: "live" } | { kind: "archive"; ms: number } | { kind: "recording"; stamp: string }): void;
}

const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const hourLabel = (h: ArchiveHour) =>
  `${new Date(h.startMs).toISOString().slice(11, 16)}Z · ${h.flights} flights${h.landings ? `, ${h.landings} landings` : ""}`;
// Recording stamps look like 2026-10-06T04-22-17-162Z.
const recordingLabel = (stamp: string) => `${dayLabel(Date.parse(stamp.slice(0, 10)))} ${stamp.slice(11, 16).replace("-", ":")}Z`;

export function createSourcePicker(
  container: HTMLElement,
  loadArchive: (() => Promise<ArchiveInfo>) | null,
  manifest: TrackManifest | null,
  handlers: SourcePickerHandlers,
): SourcePicker {
  const panel = document.createElement("div");
  panel.className = "source-picker";
  const source = document.createElement("select");
  source.setAttribute("aria-label", "Source");
  const hour = document.createElement("select");
  hour.setAttribute("aria-label", "Archive hour");
  hour.hidden = true;
  panel.append(source, hour);
  container.prepend(panel);

  let hours: ArchiveHour[] = [];
  let current: Parameters<SourcePicker["setCurrent"]>[0] | null = null;

  function render(): void {
    const days = [...new Set(hours.map((h) => Math.floor(h.startMs / DAY_MS) * DAY_MS))].reverse();
    const option = (value: string, label: string) => Object.assign(document.createElement("option"), { value, textContent: label });
    const group = (label: string, options: HTMLOptionElement[]) => {
      const g = document.createElement("optgroup");
      g.label = label;
      g.append(...options);
      return g;
    };
    const children: (HTMLOptionElement | HTMLOptGroupElement)[] = [];
    if (loadArchive) children.push(option("live", "● Live"));
    if (days.length) {
      children.push(
        group(
          "Archive",
          days.map((d) => {
            const flights = hours.filter((h) => h.startMs >= d && h.startMs < d + DAY_MS).reduce((n, h) => n + h.flights, 0);
            return option(`day:${d}`, `${dayLabel(d)} · ${flights} flights`);
          }),
        ),
      );
    }
    if (manifest?.recordings.length) {
      children.push(group("Recordings", [...manifest.recordings].reverse().map((r) => option(`rec:${r.stamp}`, recordingLabel(r.stamp)))));
    }
    source.replaceChildren(...children);
    if (current) show(current);
  }

  function renderHours(dayMs: number, selectedMs: number | null): void {
    const inDay = hours.filter((h) => h.startMs >= dayMs && h.startMs < dayMs + DAY_MS);
    hour.replaceChildren(...inDay.map((h) => Object.assign(document.createElement("option"), { value: String(h.startMs), textContent: hourLabel(h) })));
    hour.hidden = !inDay.length;
    const selected = selectedMs === null ? inDay[0] : [...inDay].reverse().find((h) => h.startMs <= selectedMs);
    if (selected) hour.value = String(selected.startMs);
  }

  function show(next: Parameters<SourcePicker["setCurrent"]>[0]): void {
    current = next;
    if (next.kind === "live") {
      source.value = "live";
      hour.hidden = true;
    } else if (next.kind === "recording") {
      source.value = `rec:${next.stamp}`;
      hour.hidden = true;
    } else {
      const dayMs = Math.floor(next.ms / DAY_MS) * DAY_MS;
      source.value = `day:${dayMs}`;
      renderHours(dayMs, next.ms);
    }
  }

  source.addEventListener("change", () => {
    const [kind, value] = source.value.split(/:(.*)/);
    if (kind === "live") handlers.live();
    else if (kind === "rec") handlers.recording(value);
    else {
      renderHours(Number(value), null);
      if (hour.value) handlers.archive(Number(hour.value));
    }
  });
  hour.addEventListener("change", () => handlers.archive(Number(hour.value)));

  async function refresh(): Promise<void> {
    if (!loadArchive) return render();
    try {
      hours = (await loadArchive()).hours;
    } catch (err) {
      console.error("Archive list unavailable", err);
    }
    render();
  }
  void refresh();
  // The archive grows while the page is open.
  setInterval(() => document.activeElement !== source && void refresh(), REFRESH_MS);

  return {
    setCurrent(next) {
      // Leave the menus alone while someone is choosing.
      if (document.activeElement === source || document.activeElement === hour) return;
      if (
        current?.kind === next.kind &&
        (next.kind === "live" ||
          (next.kind === "recording" && current.kind === "recording" && current.stamp === next.stamp) ||
          (next.kind === "archive" && current.kind === "archive" && Math.floor(current.ms / 3_600_000) === Math.floor(next.ms / 3_600_000)))
      ) {
        return;
      }
      show(next);
    },
  };
}
