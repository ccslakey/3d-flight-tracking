// Parses aviationweather.gov METAR JSON and picks the report in effect at a given time.

const HPA_PER_INHG = 33.8639;

/** Fields we use from the aviationweather.gov Data API JSON. */
export interface RawMetar {
  obsTime: number; // Unix seconds
  rawOb: string;
  altim?: number; // hPa, rounded; less precise than the raw A group
}

export interface Metar {
  obsTimeMs: number;
  altimeterInHg: number;
  altimeterSource: "A-group" | "Q-group" | "altim-hPa";
  rawOb: string;
}

/**
 * Altimeter setting in inHg. Prefers the raw report's A group (e.g. A2991 = 29.91 inHg),
 * then a Q group (hPa), then the JSON `altim` field (hPa).
 */
export function parseAltimeter(raw: RawMetar): Pick<Metar, "altimeterInHg" | "altimeterSource"> {
  // Only search the body; remarks can contain other four-digit groups.
  const body = raw.rawOb.split(" RMK ")[0];
  const aGroup = body.match(/\bA(\d{4})\b/);
  if (aGroup) return { altimeterInHg: Number(aGroup[1]) / 100, altimeterSource: "A-group" };
  const qGroup = body.match(/\bQ(\d{4})\b/);
  if (qGroup) return { altimeterInHg: Number(qGroup[1]) / HPA_PER_INHG, altimeterSource: "Q-group" };
  if (raw.altim !== undefined) return { altimeterInHg: raw.altim / HPA_PER_INHG, altimeterSource: "altim-hPa" };
  throw new Error(`No altimeter setting in METAR: ${raw.rawOb}`);
}

/** Parses and sorts METARs by observation time. */
export function parseMetars(raws: RawMetar[]): Metar[] {
  return raws
    .map((raw) => ({ obsTimeMs: raw.obsTime * 1000, rawOb: raw.rawOb, ...parseAltimeter(raw) }))
    .sort((a, b) => a.obsTimeMs - b.obsTimeMs);
}

/** The latest METAR observed at or before `tMs`. `metars` must be sorted (see parseMetars). */
export function metarAt(metars: Metar[], tMs: number): Metar {
  let lo = 0;
  let hi = metars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (metars[mid].obsTimeMs <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) throw new RangeError(`No METAR at or before ${new Date(tMs).toISOString()}`);
  return metars[found];
}
