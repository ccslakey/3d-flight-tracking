// Live relay: polls adsb.lol and KSFO METARs, archives them in SQLite for a few weeks, and serves them.
//   GET /api/history?from=<ms>&to=<ms>  flights with samples in a time window (default: the last hour), and METARs
//   GET /api/archive                    what the archive holds: its start, and flights per hour
//   GET /api/live                       Server-Sent Events: `samples` after each poll, `metar` on new METARs,
//                                       `ping` every 15 s
//   GET /api/status                     poll health and archive size
//   GET anything else                   the built app from STATIC_DIR, when it exists (production)
// Usage: tsx server/relay.ts [--raw]
//   --raw also writes raw snapshots to public/data/raw/, in record-adsb.ts format.
// Env: PORT (default 8787), RETENTION_DAYS (default 30), ARCHIVE_PATH (default data/archive.sqlite),
//      STATIC_DIR (default dist).

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Snapshot } from "../src/ingest";
import type { RawMetar } from "../src/metar";
import type { LiveSamplesEvent } from "../src/track";
import { Archive, toLiveFlightSamples } from "./archive";
import { send, serveStatic } from "./static";

const SFO_LAT = 37.6189;
const SFO_LON = -122.375;
const RADIUS_NM = 40;
const ADSB_URL = `https://api.adsb.lol/v2/point/${SFO_LAT}/${SFO_LON}/${RADIUS_NM}`;
const METAR_URL = "https://aviationweather.gov/api/data/metar?ids=KSFO&format=json";
const USER_AGENT = "flight-tracker-poc/0.1 (ADS-B live relay)";
// adsb.lol rate-limits faster polling: at 5 s about every other request got HTTP 429.
const POLL_INTERVAL_MS = 10_000;
// Each 429 stretches the interval, and each success shrinks it back by a step, so the relay
// settles just under the limit instead of bursting into it after every backoff.
const MAX_POLL_INTERVAL_MS = 30_000;
const INTERVAL_STEP_MS = 1_000;
const MAX_BACKOFF_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const METAR_INTERVAL_MS = 10 * 60_000;
const MAINTENANCE_INTERVAL_MS = 60_000;
const DEFAULT_HISTORY_MS = 3_600_000;
const MAX_METAR_HOURS = 7 * 24; // how far back a restart backfills METARs
const HEARTBEAT_MS = 15_000; // a `ping` event, so clients can tell a live stream from a hung one

const port = Number(process.env.PORT ?? 8787);
const retentionMs = Number(process.env.RETENTION_DAYS ?? 30) * 24 * 3_600_000;
const staticDir = process.env.STATIC_DIR ?? "dist";
const rawPath = process.argv.includes("--raw")
  ? join("public", "data", "raw", `adsb-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`)
  : null;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const archive = new Archive(process.env.ARCHIVE_PATH ?? join("data", "archive.sqlite"), retentionMs);
archive.prune(Date.now());
archive.finishFlights(Date.now());
log(`Archive ${JSON.stringify(archive.counts())}`);

const clients = new Set<ServerResponse>();
const lastPoll = { atMs: 0, ok: false, error: null as string | null, aircraft: 0, newSamples: 0 };
let latestNowMs: number | null = null;
let backoffMs = 0;
let pollIntervalMs = POLL_INTERVAL_MS;

function broadcast(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(message);
}

async function pollAdsbForever(): Promise<void> {
  if (rawPath) mkdirSync(join("public", "data", "raw"), { recursive: true });
  for (;;) {
    const startedAt = Date.now();
    try {
      const res = await fetch(ADSB_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryAfterMs: retryAfterSec > 0 ? retryAfterSec * 1000 : 0 });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { now: number; ac?: Snapshot["ac"] };
      const snap: Snapshot = { now: body.now, ac: body.ac ?? [] };
      if (rawPath) appendFileSync(rawPath, JSON.stringify({ recordedAt: startedAt, ...snap }) + "\n");

      const flights = toLiveFlightSamples(archive.ingest(snap));
      broadcast("samples", { now: snap.now, flights } satisfies LiveSamplesEvent);
      latestNowMs = snap.now;
      backoffMs = 0;
      pollIntervalMs = Math.max(POLL_INTERVAL_MS, pollIntervalMs - INTERVAL_STEP_MS);
      Object.assign(lastPoll, {
        atMs: startedAt,
        ok: true,
        error: null,
        aircraft: snap.ac.length,
        newSamples: flights.reduce((n, f) => n + f.samples.length, 0),
      });
    } catch (err) {
      if ((err as Error).message === "HTTP 429") pollIntervalMs = Math.min(pollIntervalMs * 1.5, MAX_POLL_INTERVAL_MS);
      backoffMs = Math.max(
        Math.min(Math.max(backoffMs * 2, pollIntervalMs), MAX_BACKOFF_MS),
        (err as { retryAfterMs?: number }).retryAfterMs ?? 0,
      );
      Object.assign(lastPoll, { atMs: startedAt, ok: false, error: (err as Error).message });
      log(`ADS-B poll failed (${(err as Error).message}), backing off ${backoffMs / 1000}s`);
      await sleep(backoffMs);
      continue;
    }
    await sleep(Math.max(0, pollIntervalMs - (Date.now() - startedAt)));
  }
}

/** Fetches METARs since the newest one held (a week at most), so every sample has one in effect. */
async function fetchMetars(): Promise<void> {
  const latestMs = archive.latestMetarMs();
  const hours = latestMs === null ? 2 : Math.min(Math.ceil((Date.now() - latestMs) / 3_600_000) + 1, MAX_METAR_HOURS);
  try {
    const res = await fetch(`${METAR_URL}&hours=${hours}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const added = archive.addMetars((await res.json()) as RawMetar[]);
    if (added.length) {
      broadcast("metar", { metars: added });
      log(`${added.length} new METAR(s)`);
    }
  } catch (err) {
    log(`METAR fetch failed (${(err as Error).message})`);
  }
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  return send(req, res, status, { "Content-Type": "application/json", "Cache-Control": "no-store" }, JSON.stringify(body));
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`Request failed: ${req.url} (${(err as Error).message})`);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://relay");
  if (req.method !== "GET") return sendJson(req, res, 405, { error: "GET only" });

  if (url.pathname === "/api/history") {
    const from = Number(url.searchParams.get("from") ?? Date.now() - DEFAULT_HISTORY_MS);
    const to = Number(url.searchParams.get("to") ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return sendJson(req, res, 400, { error: "from and to must be ms" });
    return sendJson(req, res, 200, archive.history(from, to));
  }

  if (url.pathname === "/api/archive") {
    return sendJson(req, res, 200, { startMs: archive.startMs(), retentionMs, hours: archive.hours() });
  }

  if (url.pathname === "/api/live") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    const heartbeat = setInterval(() => res.write("event: ping\ndata: {}\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === "/api/status") {
    return sendJson(req, res, 200, {
      nowMs: Date.now(),
      archiveStartMs: archive.startMs(),
      latestNowMs,
      lastPoll,
      backoffMs,
      pollIntervalMs,
      clients: clients.size,
      droppedStale: archive.droppedStale,
      ...archive.counts(),
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
    });
  }

  if (!url.pathname.startsWith("/api/") && existsSync(staticDir) && (await serveStatic(req, res, staticDir, url.pathname))) return;
  return sendJson(req, res, 404, { error: "Not found" });
}

server.listen(port, () => log(`Relay on http://localhost:${port}, retention ${retentionMs / 86_400_000} days`));

setInterval(() => {
  archive.finishFlights(Date.now());
  archive.prune(Date.now());
}, MAINTENANCE_INTERVAL_MS);

// Railway sends SIGTERM on every redeploy. Close streams and the archive so it shuts down cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log(`${signal}, shutting down`);
    for (const res of clients) res.end();
    server.close();
    archive.close();
    process.exit(0);
  });
}
await fetchMetars();
setInterval(fetchMetars, METAR_INTERVAL_MS);
void pollAdsbForever();
