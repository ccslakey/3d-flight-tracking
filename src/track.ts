// Track file formats written by scripts/extract-tracks.ts and read by the browser.
// Altitudes are raw feet as reported; convert them only through altitude.ts.

import type { RawMetar } from "./metar";

export interface TrackSample {
  tMs: number; // position time: snapshot `now` minus `seen_pos`
  lat: number;
  lon: number;
  altBaroFt: number | "ground" | null;
  altGeomFt: number | null;
  gsKt: number | null;
  trackDeg: number | null;
  trueHeadingDeg?: number | null; // nose direction; absent in recordings extracted before it was kept
  baroRateFpm: number | null;
}

export interface Landing {
  method: "ground" | "fallback";
  touchdownMs: number; // first "ground" sample, or first slow sample for fallback
  lastAirborneIndex: number;
}

export interface TrackFile {
  id: string;
  hex: string;
  flight?: string;
  typeCode?: string;
  landing: Landing | null;
  samples: TrackSample[];
}

export interface FlightSummary {
  id: string;
  hex: string;
  flight?: string;
  typeCode?: string;
  sampleCount: number;
  startMs: number;
  endMs: number;
  hasGeom: boolean;
  landing: Landing | null;
}

export interface RecordingIndex {
  source: string;
  snapshotCount: number;
  rawBytes: number;
  distinctAircraft: number;
  flightCount: number;
  droppedStale: number;
  droppedDuplicate: number;
  landings: { ground: number; fallback: number };
  flights: FlightSummary[];
}

/** List of extracted recordings, newest last. Written to /data/tracks/manifest.json. */
export interface TrackManifest {
  recordings: { stamp: string; metarFile: string }[];
}

/** One flight's new samples from a live poll, with its metadata as known at that time. */
export interface LiveFlightSamples {
  id: string;
  hex: string;
  flight?: string;
  typeCode?: string;
  samples: TrackSample[];
}

/** Payload of the relay's `samples` Server-Sent Event, sent after each poll. */
export interface LiveSamplesEvent {
  now: number; // the poll's API data time (ms)
  flights: LiveFlightSamples[];
}

/** Flights that started in one UTC hour of the relay's archive. */
export interface ArchiveHour {
  startMs: number;
  flights: number;
  landings: number;
}

/** Response of the relay's /api/archive: what it holds, for the timeline and the source picker. */
export interface ArchiveInfo {
  startMs: number | null; // oldest sample, or null when empty
  retentionMs: number;
  hours: ArchiveHour[];
}

/** Response of the relay's /api/history: flights with samples in a window, each whole, and METARs. */
export interface LiveHistory {
  flights: TrackFile[];
  metars: RawMetar[];
}
