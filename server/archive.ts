// The relay's traffic archive in SQLite: every flight the shared ingester builds, its samples,
// and KSFO METARs, kept for a retention window (days) and queried by time window.
//
// Flights still receiving samples also live in the ingester's memory, so new samples join the
// right flight. A flight is finished once it can no longer continue (no sample for
// FLIGHT_GAP_MS); its landing is detected then and it leaves memory but keeps its ID.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FLIGHT_GAP_MS, type FlightUpdate, type IngestFlight, Ingester, MAX_POS_AGE_S, type Snapshot } from "../src/ingest";
import { detectLanding } from "../src/landing";
import type { RawMetar } from "../src/metar";
import type { ArchiveHour, Landing, LiveFlightSamples, LiveHistory, TrackFile, TrackSample } from "../src/track";

const HOUR_MS = 3_600_000;
// Positions arrive up to MAX_POS_AGE_S old, so wait that long past the gap before finishing.
const FINISH_AFTER_MS = FLIGHT_GAP_MS + MAX_POS_AGE_S * 1000;

export const toLiveFlightSamples = (updates: FlightUpdate[]): LiveFlightSamples[] =>
  updates.map(({ flight: f, samples }) => ({ id: f.id, hex: f.hex, flight: f.flight, typeCode: f.typeCode, samples }));

interface SampleRow {
  flight_id: string;
  t_ms: number;
  lat: number;
  lon: number;
  alt_baro_ft: number | null;
  on_ground: number;
  alt_geom_ft: number | null;
  gs_kt: number | null;
  track_deg: number | null;
  true_heading_deg: number | null;
  baro_rate_fpm: number | null;
}

interface FlightRow {
  id: string;
  hex: string;
  flight: string | null;
  type_code: string | null;
  landing: string | null;
}

const toSample = (r: SampleRow): TrackSample => ({
  tMs: r.t_ms,
  lat: r.lat,
  lon: r.lon,
  altBaroFt: r.on_ground ? "ground" : r.alt_baro_ft,
  altGeomFt: r.alt_geom_ft,
  gsKt: r.gs_kt,
  trackDeg: r.track_deg,
  trueHeadingDeg: r.true_heading_deg,
  baroRateFpm: r.baro_rate_fpm,
});

const toTrack = (f: FlightRow, samples: TrackSample[], landing: Landing | null): TrackFile => ({
  id: f.id,
  hex: f.hex,
  flight: f.flight ?? undefined,
  typeCode: f.type_code ?? undefined,
  landing,
  samples,
});

export class Archive {
  private readonly db: DatabaseSync;
  private readonly ingester: Ingester;

  /** Opens or creates the archive at `path` (":memory:" for tests). */
  constructor(
    path: string,
    readonly retentionMs: number,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS flights (
        id TEXT PRIMARY KEY,
        hex TEXT NOT NULL,
        flight TEXT,
        type_code TEXT,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0,
        landing TEXT
      );
      CREATE INDEX IF NOT EXISTS flights_start ON flights (start_ms);
      CREATE INDEX IF NOT EXISTS flights_end ON flights (end_ms);
      CREATE TABLE IF NOT EXISTS samples (
        flight_id TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        alt_baro_ft REAL,
        on_ground INTEGER NOT NULL,
        alt_geom_ft REAL,
        gs_kt REAL,
        track_deg REAL,
        true_heading_deg REAL,
        baro_rate_fpm REAL
      );
      CREATE INDEX IF NOT EXISTS samples_flight ON samples (flight_id, t_ms);
      CREATE TABLE IF NOT EXISTS metars (obs_time INTEGER PRIMARY KEY, raw TEXT NOT NULL);
    `);

    // Unfinished flights go back into the ingester so they can keep growing.
    const active = this.db.prepare("SELECT id, hex, flight, type_code FROM flights WHERE finished = 0").all() as unknown as FlightRow[];
    const restored: IngestFlight[] = active.map((f) => ({
      id: f.id,
      hex: f.hex,
      flight: f.flight ?? undefined,
      typeCode: f.type_code ?? undefined,
      samples: this.samplesOf(f.id),
    }));
    const finishedIds = (this.db.prepare("SELECT id FROM flights WHERE finished = 1").all() as { id: string }[]).map((r) => r.id);
    this.ingester = new Ingester(restored, finishedIds);
  }

  get droppedStale(): number {
    return this.ingester.droppedStale;
  }

  /** Ingests one snapshot, stores its new samples, and returns them grouped by flight. */
  ingest(snap: Snapshot): FlightUpdate[] {
    const updates = this.ingester.ingest(snap);
    if (!updates.length) return updates;
    const upsertFlight = this.db.prepare(`
      INSERT INTO flights (id, hex, flight, type_code, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        flight = coalesce(excluded.flight, flight),
        type_code = coalesce(excluded.type_code, type_code),
        start_ms = min(start_ms, excluded.start_ms),
        end_ms = max(end_ms, excluded.end_ms)`);
    const insertSample = this.db.prepare("INSERT INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.transaction(() => {
      for (const { flight: f, samples } of updates) {
        const times = samples.map((s) => s.tMs);
        upsertFlight.run(f.id, f.hex, f.flight ?? null, f.typeCode ?? null, Math.min(...times), Math.max(...times));
        for (const s of samples) {
          const ground = s.altBaroFt === "ground";
          insertSample.run(
            f.id,
            s.tMs,
            s.lat,
            s.lon,
            ground ? null : s.altBaroFt,
            ground ? 1 : 0,
            s.altGeomFt,
            s.gsKt,
            s.trackDeg,
            s.trueHeadingDeg ?? null,
            s.baroRateFpm,
          );
        }
      }
    });
    return updates;
  }

  /** Adds METARs not already held and returns the new ones. */
  addMetars(raws: RawMetar[]): RawMetar[] {
    const insert = this.db.prepare("INSERT OR IGNORE INTO metars (obs_time, raw) VALUES (?, ?)");
    const added: RawMetar[] = [];
    this.transaction(() => {
      for (const m of raws) if (insert.run(m.obsTime, JSON.stringify(m)).changes) added.push(m);
    });
    return added.sort((a, b) => a.obsTime - b.obsTime);
  }

  /** Observation time (ms) of the newest METAR held, or null. */
  latestMetarMs(): number | null {
    const row = this.db.prepare("SELECT max(obs_time) AS t FROM metars").get() as { t: number | null };
    return row.t === null ? null : row.t * 1000;
  }

  /**
   * Every flight with samples in [fromMs, toMs], each with all of its samples so landings and
   * headings see the whole flight, and the METARs covering the window, including the one in
   * effect at its start.
   */
  history(fromMs: number, toMs: number): LiveHistory {
    const rows = this.db
      .prepare("SELECT id, hex, flight, type_code, landing FROM flights WHERE start_ms <= ? AND end_ms >= ? ORDER BY start_ms")
      .all(toMs, fromMs) as unknown as FlightRow[];
    const flights = rows.map((f) => {
      const samples = this.samplesOf(f.id);
      // Unfinished flights have no stored landing yet, but may already have touched down.
      const landing = f.landing ? (JSON.parse(f.landing) as Landing) : detectLanding(samples);
      return toTrack(f, samples, landing);
    });
    const metars = (
      this.db
        .prepare(
          `SELECT raw FROM metars
           WHERE obs_time >= coalesce((SELECT max(obs_time) FROM metars WHERE obs_time <= ?), 0) AND obs_time <= ?
           ORDER BY obs_time`,
        )
        .all(fromMs / 1000, toMs / 1000) as { raw: string }[]
    ).map((r) => JSON.parse(r.raw) as RawMetar);
    return { flights, metars };
  }

  /** Flight and landing counts per UTC hour of flight start, oldest first. */
  hours(): ArchiveHour[] {
    return (
      this.db
        .prepare(
          `SELECT (start_ms / ${HOUR_MS}) * ${HOUR_MS} AS startMs, count(*) AS flights, count(landing) AS landings
           FROM flights GROUP BY start_ms / ${HOUR_MS} ORDER BY startMs`,
        )
        .all() as unknown as ArchiveHour[]
    ).map((h) => ({ startMs: Number(h.startMs), flights: Number(h.flights), landings: Number(h.landings) }));
  }

  /** Time of the oldest sample held, or null when empty. */
  startMs(): number | null {
    const row = this.db.prepare("SELECT min(start_ms) AS t FROM flights").get() as { t: number | null };
    return row.t;
  }

  /** Finishes flights that can no longer continue: stores their landing and drops them from memory. */
  finishFlights(nowMs: number): number {
    const done = [...this.ingester.flights.values()].filter((f) => nowMs - lastSampleMs(f) > FINISH_AFTER_MS);
    const update = this.db.prepare("UPDATE flights SET finished = 1, landing = ? WHERE id = ?");
    this.transaction(() => {
      for (const f of done) {
        const landing = detectLanding(f.samples);
        update.run(landing ? JSON.stringify(landing) : null, f.id);
      }
    });
    for (const f of done) this.ingester.retire(f.id);
    return done.length;
  }

  /** Drops flights that ended before the retention window, and METARs no longer in effect in it. */
  prune(nowMs: number): number {
    const startMs = nowMs - this.retentionMs;
    const ids = (this.db.prepare("SELECT id FROM flights WHERE end_ms < ?").all(startMs) as { id: string }[]).map((r) => r.id);
    const deleteSamples = this.db.prepare("DELETE FROM samples WHERE flight_id = ?");
    const deleteFlight = this.db.prepare("DELETE FROM flights WHERE id = ?");
    this.transaction(() => {
      for (const id of ids) {
        deleteSamples.run(id);
        deleteFlight.run(id);
      }
      this.db
        .prepare("DELETE FROM metars WHERE obs_time < (SELECT max(obs_time) FROM metars WHERE obs_time <= ?)")
        .run(startMs / 1000);
    });
    for (const id of ids) this.ingester.remove(id);
    return ids.length;
  }

  counts(): { flights: number; activeFlights: number; metars: number; dbMb: number } {
    const count = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    const pages = count("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()");
    return {
      flights: count("SELECT count(*) AS n FROM flights"),
      activeFlights: this.ingester.flights.size,
      metars: count("SELECT count(*) AS n FROM metars"),
      dbMb: Math.round(pages / 1e5) / 10,
    };
  }

  close(): void {
    this.db.close();
  }

  private samplesOf(flightId: string): TrackSample[] {
    return (this.db.prepare("SELECT * FROM samples WHERE flight_id = ? ORDER BY t_ms").all(flightId) as unknown as SampleRow[]).map(
      toSample,
    );
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

const lastSampleMs = (f: IngestFlight) => f.samples[f.samples.length - 1]?.tMs ?? -Infinity;
