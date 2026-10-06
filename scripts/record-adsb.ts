// Polls adsb.lol around SFO and appends each snapshot as one NDJSON line.
// Usage: tsx scripts/record-adsb.ts [durationMinutes=60] [intervalSec=5]

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SFO_LAT = 37.6189;
const SFO_LON = -122.375;
const RADIUS_NM = 40;
const URL = `https://api.adsb.lol/v2/point/${SFO_LAT}/${SFO_LON}/${RADIUS_NM}`;
const USER_AGENT = "flight-tracker-poc/0.1 (ADS-B replay research)";
const MAX_BACKOFF_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000; // a hung connection otherwise stalls for minutes

const durationMin = Number(process.argv[2] ?? 60);
const intervalMs = Number(process.argv[3] ?? 5) * 1000;

const outDir = join("public", "data", "raw");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(outDir, `adsb-${stamp}.ndjson`);

const endAt = Date.now() + durationMin * 60_000;
let backoffMs = 0;
let snapshots = 0;
let failures = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

log(`Recording ${durationMin} min to ${outPath}`);

while (Date.now() < endAt) {
  const startedAt = Date.now();
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429 || res.status >= 500) {
      backoffMs = Math.min(Math.max(backoffMs * 2, intervalMs), MAX_BACKOFF_MS);
      const retryAfterSec = Number(res.headers.get("retry-after"));
      if (retryAfterSec > 0) backoffMs = Math.max(backoffMs, retryAfterSec * 1000);
      failures++;
      log(`HTTP ${res.status}, backing off ${backoffMs / 1000}s`);
      await sleep(backoffMs);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { now: number; ac?: unknown[] };
    // `now` is the API's data time (ms); per-aircraft `seen`/`seen_pos` are relative to it.
    appendFileSync(outPath, JSON.stringify({ recordedAt: startedAt, now: body.now, ac: body.ac ?? [] }) + "\n");
    snapshots++;
    backoffMs = 0;
    if (snapshots % 60 === 0) {
      log(`${snapshots} snapshots, ${body.ac?.length ?? 0} aircraft in latest`);
    }
  } catch (err) {
    failures++;
    backoffMs = Math.min(Math.max(backoffMs * 2, intervalMs), MAX_BACKOFF_MS);
    log(`Request failed (${(err as Error).message}), backing off ${backoffMs / 1000}s`);
    await sleep(backoffMs);
    continue;
  }
  await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
}

log(`Done: ${snapshots} snapshots, ${failures} failures, ${outPath}`);
