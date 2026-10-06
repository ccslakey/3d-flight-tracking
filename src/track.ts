// Track file formats written by scripts/extract-tracks.ts and read by the browser.
// Altitudes are raw feet as reported; convert them only through altitude.ts.

export interface TrackSample {
  tMs: number; // position time: snapshot `now` minus `seen_pos`
  lat: number;
  lon: number;
  altBaroFt: number | "ground" | null;
  altGeomFt: number | null;
  gsKt: number | null;
  trackDeg: number | null;
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
