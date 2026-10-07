// Hourly NDJSON log of what the relay ingested, so a restart keeps its history.
// Each line is one poll's new samples or a batch of new METARs. Files are named by the
// UTC hour they were written in and deleted once that hour is outside retention.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FlightUpdate, IngestFlight } from "../src/ingest";
import type { RawMetar } from "../src/metar";
import type { TrackSample } from "../src/track";

const HOUR_MS = 3_600_000;
const FILE_RE = /^live-(\d{4}-\d{2}-\d{2}T\d{2})\.ndjson$/;

/** A flight's new samples from one poll, with its metadata as known at that time. */
export interface LoggedFlight {
  id: string;
  hex: string;
  flight?: string;
  typeCode?: string;
  samples: TrackSample[];
}

type LogLine = { kind: "samples"; now: number; flights: LoggedFlight[] } | { kind: "metars"; metars: RawMetar[] };

export const toLoggedFlights = (updates: FlightUpdate[]): LoggedFlight[] =>
  updates.map(({ flight: f, samples }) => ({ id: f.id, hex: f.hex, flight: f.flight, typeCode: f.typeCode, samples }));

const hourStartMs = (name: string) => Date.parse(`${name.match(FILE_RE)![1]}:00:00Z`);

export class SampleLog {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  appendSamples(now: number, flights: LoggedFlight[]): void {
    if (flights.length) this.append({ kind: "samples", now, flights });
  }

  appendMetars(metars: RawMetar[]): void {
    if (metars.length) this.append({ kind: "metars", metars });
  }

  /** Deletes files whose whole hour is before `startMs`. */
  deleteBefore(startMs: number): void {
    for (const name of this.files()) {
      if (hourStartMs(name) + HOUR_MS < startMs) rmSync(join(this.dir, name));
    }
  }

  /** Rebuilds flights and METARs from files that overlap the window starting at `startMs`. */
  load(startMs: number): { flights: IngestFlight[]; metars: RawMetar[] } {
    this.deleteBefore(startMs);
    const flights = new Map<string, IngestFlight>();
    const metars: RawMetar[] = [];
    for (const name of this.files().sort()) {
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (!line) continue;
        const entry = JSON.parse(line) as LogLine;
        if (entry.kind === "metars") {
          metars.push(...entry.metars);
          continue;
        }
        for (const logged of entry.flights) {
          let f = flights.get(logged.id);
          if (!f) flights.set(logged.id, (f = { id: logged.id, hex: logged.hex, samples: [] }));
          f.flight ??= logged.flight;
          f.typeCode ??= logged.typeCode;
          f.samples.push(...logged.samples);
        }
      }
    }
    for (const f of flights.values()) f.samples.sort((a, b) => a.tMs - b.tMs);
    return { flights: [...flights.values()], metars };
  }

  private append(line: LogLine): void {
    const hour = new Date().toISOString().slice(0, 13);
    appendFileSync(join(this.dir, `live-${hour}.ndjson`), JSON.stringify(line) + "\n");
  }

  private files(): string[] {
    return existsSync(this.dir) ? readdirSync(this.dir).filter((n) => FILE_RE.test(n)) : [];
  }
}
