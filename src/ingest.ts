// Turns adsb.lol snapshots into per-flight samples, one snapshot at a time. Shared by
// scripts/extract-tracks.ts (batch) and the live relay so both apply the same rules.
// Altitudes stay raw (feet, as reported); conversion happens only in altitude.ts.

import type { TrackSample } from "./track";

export const MAX_POS_AGE_S = 15; // older positions are stale carry-overs
export const FLIGHT_GAP_MS = 10 * 60_000; // split one hex into separate flights after this gap
const DUPLICATE_MS = 100; // same position time as the last poll means nothing new was received
// Some ADS-R ground vehicles at SFO report this fixed point off Half Moon Bay instead of their position.
const PLACEHOLDER_POSITION = { lat: 37.5, lon: -122.553191 };

export interface RawAircraft {
  hex: string;
  type?: string;
  flight?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  seen?: number;
  seen_pos?: number;
}

/** One poll of the API. `now` is its data time (ms); `seen`/`seen_pos` are relative to it. */
export interface Snapshot {
  now: number;
  ac: RawAircraft[];
}

export interface IngestFlight {
  id: string;
  hex: string;
  flight?: string;
  typeCode?: string;
  samples: TrackSample[];
}

/** Samples a snapshot added to one flight. */
export interface FlightUpdate {
  flight: IngestFlight;
  samples: TrackSample[];
}

/** The hex if unused, else the hex with the first free index. An ID is never reassigned. */
export function assignFlightId(hex: string, usedIds: Set<string>): string {
  if (!usedIds.has(hex)) return hex;
  let i = 1;
  while (usedIds.has(`${hex}-${i}`)) i++;
  return `${hex}-${i}`;
}

/** Converts one aircraft entry to a sample timed by its position age, or null if it has no usable position. */
export function toSample(ac: RawAircraft, nowMs: number): TrackSample | null {
  if (ac.lat === undefined || ac.lon === undefined || ac.seen_pos === undefined) return null;
  if (ac.lat === PLACEHOLDER_POSITION.lat && ac.lon === PLACEHOLDER_POSITION.lon) return null;
  return {
    tMs: Math.round(nowMs - ac.seen_pos * 1000),
    lat: ac.lat,
    lon: ac.lon,
    altBaroFt: ac.alt_baro ?? null,
    altGeomFt: ac.alt_geom ?? null,
    gsKt: ac.gs ?? null,
    trackDeg: ac.track ?? null,
    trueHeadingDeg: ac.true_heading ?? null,
    baroRateFpm: ac.baro_rate ?? null,
  };
}

export class Ingester {
  readonly flights = new Map<string, IngestFlight>();
  droppedStale = 0;
  droppedDuplicate = 0;
  private readonly usedIds: Set<string>;
  private readonly currentByHex = new Map<string, IngestFlight>();
  private readonly lastReceivedByHex = new Map<string, TrackSample>();

  /**
   * `existing` restores flights kept from earlier runs, so their IDs stay taken and they can keep
   * growing. `reservedIds` are IDs of flights held elsewhere, such as finished archived flights.
   */
  constructor(existing: Iterable<IngestFlight> = [], reservedIds: Iterable<string> = []) {
    for (const f of existing) {
      this.flights.set(f.id, f);
      const current = this.currentByHex.get(f.hex);
      if (!current || lastMs(f) > lastMs(current)) this.currentByHex.set(f.hex, f);
    }
    this.usedIds = new Set([...reservedIds, ...this.flights.keys()]);
  }

  /** Adds a snapshot's new positions and returns the samples it added, grouped by flight. */
  ingest(snap: Snapshot): FlightUpdate[] {
    const updates = new Map<IngestFlight, TrackSample[]>();
    for (const ac of snap.ac) {
      const sample = toSample(ac, snap.now);
      if (!sample) continue;
      if (ac.seen_pos! > MAX_POS_AGE_S) {
        this.droppedStale++;
        continue;
      }

      let flight = this.currentByHex.get(ac.hex);
      // Compare with the last sample received, which is not always the latest in time.
      const last = this.lastReceivedByHex.get(ac.hex) ?? flight?.samples[flight.samples.length - 1];
      if (last && Math.abs(sample.tMs - last.tMs) < DUPLICATE_MS) {
        this.droppedDuplicate++;
        continue;
      }
      if (!flight || (last && sample.tMs - last.tMs > FLIGHT_GAP_MS)) {
        flight = this.startFlight(ac.hex);
      }
      flight.flight ??= ac.flight?.trim() || undefined;
      flight.typeCode ??= ac.t;
      insertByTime(flight.samples, sample);
      this.lastReceivedByHex.set(ac.hex, sample);
      updates.set(flight, [...(updates.get(flight) ?? []), sample]);
    }
    return [...updates].map(([flight, samples]) => ({ flight, samples }));
  }

  /** Forgets a flight, freeing its ID. Used when retention drops all of its samples. */
  remove(id: string): void {
    this.retire(id);
    this.usedIds.delete(id);
  }

  /**
   * Forgets a finished flight's samples but keeps its ID taken. A later position for its hex
   * starts a new flight, as it would after FLIGHT_GAP_MS anyway.
   */
  retire(id: string): void {
    const flight = this.flights.get(id);
    if (!flight) return;
    this.flights.delete(id);
    if (this.currentByHex.get(flight.hex) === flight) this.currentByHex.delete(flight.hex);
  }

  private startFlight(hex: string): IngestFlight {
    const id = assignFlightId(hex, this.usedIds);
    this.usedIds.add(id);
    const flight: IngestFlight = { id, hex, samples: [] };
    this.flights.set(id, flight);
    this.currentByHex.set(hex, flight);
    return flight;
  }
}

const lastMs = (f: IngestFlight) => f.samples[f.samples.length - 1]?.tMs ?? -Infinity;

/** Keeps samples in time order; position ages can put a sample slightly before the previous one. */
function insertByTime(samples: TrackSample[], sample: TrackSample): void {
  let i = samples.length;
  while (i > 0 && samples[i - 1].tMs > sample.tMs) i--;
  samples.splice(i, 0, sample);
}
