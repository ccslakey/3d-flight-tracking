// Live relay: polls adsb.lol and KSFO METARs, keeps the last few hours, and serves them.
//   GET /api/history?from=<ms>&to=<ms>  tracks and METARs in a time window (default: all held), and the retention
//   GET /api/live                       Server-Sent Events: `samples` after each poll, `metar` on new METARs,
//                                       `ping` every 15 s
//   GET /api/status                     poll health and store size
//   GET anything else                   the built app from STATIC_DIR, when it exists (production)
// Usage: tsx server/relay.ts [--raw]
//   --raw also writes raw snapshots to public/data/raw/, in record-adsb.ts format.
// Env: PORT (default 8787), RETENTION_HOURS (default 4), LIVE_DATA_DIR (default data/live),
//      STATIC_DIR (default dist).

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Snapshot } from "../src/ingest";
import type { RawMetar } from "../src/metar";
import type { LiveSamplesEvent } from "../src/track";
import { SampleLog, toLiveFlightSamples } from "./sampleLog";
import { send, serveStatic } from "./static";
import { LiveStore } from "./store";

const SFO_LAT = 37.6189;
const SFO_LON = -122.375;
const RADIUS_NM = 40;
const ADSB_URL = `https://api.adsb.lol/v2/point/${SFO_LAT}/${SFO_LON}/${RADIUS_NM}`;
const METAR_URL = "https://aviationweather.gov/api/data/metar?ids=KSFO&format=json";
const USER_AGENT = "flight-tracker-poc/0.1 (ADS-B live relay)";
const POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const METAR_INTERVAL_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 15_000; // a `ping` event, so clients can tell a live stream from a hung one

const port = Number(process.env.PORT ?? 8787);
const retentionMs = Number(process.env.RETENTION_HOURS ?? 4) * 3_600_000;
const staticDir = process.env.STATIC_DIR ?? "dist";
const rawPath = process.argv.includes("--raw")
  ? join("public", "data", "raw", `adsb-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`)
  : null;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sampleLog = new SampleLog(process.env.LIVE_DATA_DIR ?? join("data", "live"));
const store = new LiveStore(retentionMs, sampleLog.load(Date.now() - retentionMs));
store.prune(Date.now());
log(`Restored ${JSON.stringify(store.counts())}`);

const clients = new Set<ServerResponse>();
const lastPoll = { atMs: 0, ok: false, error: null as string | null, aircraft: 0, newSamples: 0 };
let latestNowMs: number | null = null;
let backoffMs = 0;

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

      const flights = toLiveFlightSamples(store.ingest(snap));
      sampleLog.appendSamples(snap.now, flights);
      broadcast("samples", { now: snap.now, flights } satisfies LiveSamplesEvent);
      latestNowMs = snap.now;
      backoffMs = 0;
      Object.assign(lastPoll, {
        atMs: startedAt,
        ok: true,
        error: null,
        aircraft: snap.ac.length,
        newSamples: flights.reduce((n, f) => n + f.samples.length, 0),
      });
    } catch (err) {
      backoffMs = Math.max(
        Math.min(Math.max(backoffMs * 2, POLL_INTERVAL_MS), MAX_BACKOFF_MS),
        (err as { retryAfterMs?: number }).retryAfterMs ?? 0,
      );
      Object.assign(lastPoll, { atMs: startedAt, ok: false, error: (err as Error).message });
      log(`ADS-B poll failed (${(err as Error).message}), backing off ${backoffMs / 1000}s`);
      await sleep(backoffMs);
      continue;
    }
    await sleep(Math.max(0, POLL_INTERVAL_MS - (Date.now() - startedAt)));
  }
}

/** Fetches METARs back to the retention start plus an hour, so every held sample has one in effect. */
async function fetchMetars(): Promise<void> {
  const hours = Math.ceil(retentionMs / 3_600_000) + 2;
  try {
    const res = await fetch(`${METAR_URL}&hours=${hours}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const added = store.addMetars((await res.json()) as RawMetar[]);
    if (added.length) {
      sampleLog.appendMetars(added);
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
    const from = Number(url.searchParams.get("from") ?? Date.now() - retentionMs);
    const to = Number(url.searchParams.get("to") ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return sendJson(req, res, 400, { error: "from and to must be ms" });
    return sendJson(req, res, 200, { ...store.history(from, to), retentionMs });
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
      retentionStartMs: Date.now() - retentionMs,
      latestNowMs,
      lastPoll,
      backoffMs,
      clients: clients.size,
      droppedStale: store.droppedStale,
      ...store.counts(),
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
    });
  }

  if (!url.pathname.startsWith("/api/") && existsSync(staticDir) && (await serveStatic(req, res, staticDir, url.pathname))) return;
  return sendJson(req, res, 404, { error: "Not found" });
}

server.listen(port, () => log(`Relay on http://localhost:${port}, retention ${retentionMs / 3_600_000} h`));

setInterval(() => {
  store.prune(Date.now());
  sampleLog.deleteBefore(Date.now() - retentionMs);
}, PRUNE_INTERVAL_MS);
await fetchMetars();
setInterval(fetchMetars, METAR_INTERVAL_MS);
void pollAdsbForever();
