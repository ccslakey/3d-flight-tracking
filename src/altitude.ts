// The only place altitude units and references are converted. Everything rendered on the
// globe gets its height from here. Output heights are meters above the WGS84 ellipsoid.

export const M_PER_FT = 0.3048;
export const STANDARD_ALTIMETER_INHG = 29.92;

export type AltSource = "geom" | "baro-corrected" | "ground" | "none";

export interface AltSample {
  altBaroFt: number | "ground" | null;
  altGeomFt: number | null;
}

export interface AltContext {
  altimeterInHg: number;
  geoidN: number; // geoid undulation in meters (ellipsoid height minus MSL height)
  geomReference: "HAE" | "MSL";
}

export interface AltResult {
  heightM: number | null; // null for ground (clamped to terrain by the render layer) or no altitude
  source: AltSource;
  deltaGeomBaroM?: number; // geom minus corrected baro, both as ellipsoid heights
}

export const metersToFeet = (m: number): number => m / M_PER_FT;

/** An MSL (orthometric) height in feet, such as a field elevation, as ellipsoid height. */
export function mslFtToEllipsoidM(mslFt: number, geoidN: number): number {
  return mslFt * M_PER_FT + geoidN;
}

/** Pressure altitude corrected with the local altimeter setting, as ellipsoid height. */
export function baroToEllipsoidM(altBaroFt: number, altimeterInHg: number, geoidN: number): number {
  const mslFt = altBaroFt + (altimeterInHg - STANDARD_ALTIMETER_INHG) * 1000;
  return mslFtToEllipsoidM(mslFt, geoidN);
}

/** Pressure altitude treated as MSL with no altimeter correction. For debug comparison only. */
export function uncorrectedBaroToEllipsoidM(altBaroFt: number, geoidN: number): number {
  return baroToEllipsoidM(altBaroFt, STANDARD_ALTIMETER_INHG, geoidN);
}

/** GNSS altitude as ellipsoid height; adds N only when the aircraft reports MSL. */
export function geomToEllipsoidM(altGeomFt: number, geomReference: "HAE" | "MSL", geoidN: number): number {
  return geomReference === "MSL" ? mslFtToEllipsoidM(altGeomFt, geoidN) : altGeomFt * M_PER_FT;
}

/**
 * Ellipsoid height for one ADS-B sample. Geom is preferred: Phase 6 validation found it
 * HAE-referenced and closer to the runway at touchdown than corrected baro, which reads
 * about 40 ft low there. Corrected baro is the fallback when geom is missing.
 */
export function toEllipsoidHeight(sample: AltSample, ctx: AltContext): AltResult {
  if (sample.altBaroFt === "ground") return { heightM: null, source: "ground" };

  const baroM =
    sample.altBaroFt !== null ? baroToEllipsoidM(sample.altBaroFt, ctx.altimeterInHg, ctx.geoidN) : null;
  const geomM =
    sample.altGeomFt !== null ? geomToEllipsoidM(sample.altGeomFt, ctx.geomReference, ctx.geoidN) : null;

  if (geomM !== null) {
    const result: AltResult = { heightM: geomM, source: "geom" };
    if (baroM !== null) result.deltaGeomBaroM = geomM - baroM;
    return result;
  }
  if (baroM !== null) return { heightM: baroM, source: "baro-corrected" };
  return { heightM: null, source: "none" };
}
