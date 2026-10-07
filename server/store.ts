// In-memory live traffic for the relay: flights from the shared ingester plus METARs,
// trimmed to a retention window and queried by time window.

import { type FlightUpdate, type IngestFlight, Ingester, type Snapshot } from "../src/ingest";
import type { RawMetar } from "../src/metar";
import type { TrackFile } from "../src/track";

export interface History {
  flights: TrackFile[];
  metars: RawMetar[];
}

export class LiveStore {
  private readonly ingester: Ingester;
  private metars: RawMetar[] = [];

  constructor(
    readonly retentionMs: number,
    restored: { flights?: Iterable<IngestFlight>; metars?: RawMetar[] } = {},
  ) {
    this.ingester = new Ingester(restored.flights);
    this.addMetars(restored.metars ?? []);
  }

  get droppedStale(): number {
    return this.ingester.droppedStale;
  }

  ingest(snap: Snapshot): FlightUpdate[] {
    return this.ingester.ingest(snap);
  }

  /** Adds METARs not already held and returns the new ones. */
  addMetars(raws: RawMetar[]): RawMetar[] {
    const known = new Set(this.metars.map((m) => m.obsTime));
    const added = raws.filter((m) => !known.has(m.obsTime) && known.add(m.obsTime));
    if (added.length) this.metars = [...this.metars, ...added].sort((a, b) => a.obsTime - b.obsTime);
    return added;
  }

  /**
   * Flights with their samples in [fromMs, toMs], omitting flights with none, and the METARs
   * covering the window, including the one in effect at its start.
   */
  history(fromMs: number, toMs: number): History {
    const flights: TrackFile[] = [];
    for (const f of this.ingester.flights.values()) {
      const samples = f.samples.filter((s) => s.tMs >= fromMs && s.tMs <= toMs);
      if (samples.length) flights.push({ id: f.id, hex: f.hex, flight: f.flight, typeCode: f.typeCode, landing: null, samples });
    }
    return { flights, metars: this.metarsFrom(fromMs).filter((m) => m.obsTime * 1000 <= toMs) };
  }

  /** Drops samples older than the retention window, and flights and METARs left outside it. */
  prune(nowMs: number): void {
    const startMs = nowMs - this.retentionMs;
    for (const f of [...this.ingester.flights.values()]) {
      const keepFrom = f.samples.findIndex((s) => s.tMs >= startMs);
      if (keepFrom < 0) this.ingester.remove(f.id);
      else f.samples.splice(0, keepFrom);
    }
    this.metars = this.metarsFrom(startMs);
  }

  counts(): { flights: number; samples: number; metars: number } {
    let samples = 0;
    for (const f of this.ingester.flights.values()) samples += f.samples.length;
    return { flights: this.ingester.flights.size, samples, metars: this.metars.length };
  }

  /** METARs from the one in effect at `fromMs` onward. */
  private metarsFrom(fromMs: number): RawMetar[] {
    let first = 0;
    for (let i = 0; i < this.metars.length && this.metars[i].obsTime * 1000 <= fromMs; i++) first = i;
    return this.metars.slice(first);
  }
}
