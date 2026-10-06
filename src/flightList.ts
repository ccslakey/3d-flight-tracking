// Searchable list of recorded flights. Clicking a row calls onSelect.

import type { ReplayFlight } from "./replay";

export interface FlightList {
  setSelected(id: string | null): void;
}

export function createFlightList(
  container: HTMLElement,
  flights: ReplayFlight[],
  onSelect: (flight: ReplayFlight) => void,
): FlightList {
  const panel = document.createElement("div");
  panel.className = "flight-list";

  const landings = flights.filter((f) => f.track.landing).length;
  const header = document.createElement("div");
  header.className = "flight-list-title";
  header.textContent = `${flights.length} flights, ${landings} SFO landings`;

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter by callsign, hex, or type";
  search.className = "flight-list-search";

  const list = document.createElement("ul");
  const rows = new Map<string, HTMLLIElement>();
  const sorted = [...flights].sort((a, b) => a.startMs - b.startMs);
  for (const flight of sorted) {
    const { track } = flight;
    const li = document.createElement("li");
    li.dataset.search = [track.flight, track.hex, track.typeCode].filter(Boolean).join(" ").toLowerCase();
    const time = new Date(flight.startMs).toISOString().slice(11, 16);
    li.innerHTML = `<span class="fl-callsign"></span><span class="fl-type"></span><span class="fl-time">${time}Z</span>`;
    li.querySelector(".fl-callsign")!.textContent = track.flight ?? track.hex;
    li.querySelector(".fl-type")!.textContent = track.typeCode ?? "";
    if (track.landing) li.classList.add("is-landing");
    li.addEventListener("click", () => onSelect(flight));
    list.append(li);
    rows.set(track.id, li);
  }

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const li of rows.values()) li.hidden = q !== "" && !li.dataset.search!.includes(q);
  });

  panel.append(header, search, list);
  container.append(panel);

  let selected: HTMLLIElement | undefined;
  return {
    setSelected(id) {
      selected?.classList.remove("is-selected");
      selected = id ? rows.get(id) : undefined;
      selected?.classList.add("is-selected");
      selected?.scrollIntoView({ block: "nearest" });
    },
  };
}
