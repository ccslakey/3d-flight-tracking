// Searchable list of recorded flights. Clicking a row calls onSelect.

import type { ReplayFlight } from "./replay";

export interface FlightList {
  setSelected(id: string | null): void;
  /** Appends a flight that started after the list was built. */
  add(flight: ReplayFlight): void;
}

export function createFlightList(
  container: HTMLElement,
  flights: ReplayFlight[],
  onSelect: (flight: ReplayFlight) => void,
): FlightList {
  const panel = document.createElement("div");
  panel.className = "flight-list";

  const header = document.createElement("div");
  header.className = "flight-list-title";
  let flightCount = 0;
  let landings = 0;

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter by callsign, hex, or type";
  search.className = "flight-list-search";

  const list = document.createElement("ul");
  const rows = new Map<string, HTMLLIElement>();
  function add(flight: ReplayFlight): void {
    const { track } = flight;
    const li = document.createElement("li");
    li.dataset.search = [track.flight, track.hex, track.typeCode].filter(Boolean).join(" ").toLowerCase();
    const time = new Date(flight.startMs).toISOString().slice(11, 16);
    li.innerHTML = `<span class="fl-callsign"></span><span class="fl-type"></span><span class="fl-time">${time}Z</span>`;
    li.querySelector(".fl-callsign")!.textContent = track.flight ?? track.hex;
    li.querySelector(".fl-type")!.textContent = track.typeCode ?? "";
    if (track.landing) li.classList.add("is-landing");
    li.addEventListener("click", () => onSelect(flight));
    li.hidden = !matches(li);
    list.append(li);
    rows.set(track.id, li);
    flightCount++;
    if (track.landing) landings++;
    header.textContent = `${flightCount} flights, ${landings} SFO landings`;
  }

  const matches = (li: HTMLLIElement) => {
    const q = search.value.trim().toLowerCase();
    return q === "" || li.dataset.search!.includes(q);
  };

  for (const flight of [...flights].sort((a, b) => a.startMs - b.startMs)) add(flight);
  search.addEventListener("input", () => {
    for (const li of rows.values()) li.hidden = !matches(li);
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
    add,
  };
}
