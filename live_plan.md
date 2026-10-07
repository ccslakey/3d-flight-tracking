# Live Replay with Rewind

## Goal

Show live ADS-B traffic around SFO on the existing 3D globe, and let the viewer scrub back through the last few hours and return to live. Live is the moving end of a continuous recording: the same altitude, heading, and rendering code serves both, and the recorded `?rec=` replays keep working.

## Constraints

- Everything in `initial_plan.md` still applies: plain TypeScript and DOM, altitude conversion only in `altitude.ts`, units in variable names, Vitest for unit tests.
- The browser never calls adsb.lol or aviationweather.gov. A Node relay polls both and serves the browser.
- One poller for all viewers, at the same 5 s interval and backoff as `record-adsb.ts`.
- Rewind depth is a few hours. Retention is a relay setting, `RETENTION_HOURS` (default 4). Nothing older is kept or served.
- The relay runs on its own (`npm run relay`, run with `tsx`), so the same process can later be hosted. In development, Vite proxies `/api` to it.
- Check the installed Cesium version's API before writing incremental sample or pruning code (for example, whether `SampledProperty.removeSamples` exists).
- Stop at each **Checkpoint** below and report results before continuing.

## Design

### Shared ingest

`extract-tracks.ts` already turns raw snapshots into samples: timestamp from `now - seen_pos`, stale positions dropped, repeated position times dropped, and a hex split into separate flights after a 10 min gap. Move that logic into `src/ingest.ts` as pure functions that take one snapshot at a time. Both the batch extractor and the relay use it, so live and recorded samples cannot drift apart.

A flight's ID is assigned once, when the flight is created, and never changes. The ID is the hex. If a flight with that ID already exists, add the first free index (`<hex>-1`, `<hex>-2`, …). "Exists" means any flight the relay holds, including history reloaded from disk. The persisted samples carry their flight ID, so a restart restores IDs rather than generating them again. The batch extractor uses the same rule, which replaces its current numbering, where every segment of a split hex gets an index and the first is `<hex>-0`.

### Relay (`server/relay.ts`)

- **Store:** in memory, flights keyed by ID, each holding metadata and its samples, plus the METARs. Samples older than the retention window are dropped once a minute, and so are flights left with none.
- **Persistence:** each poll's new samples are appended as one NDJSON line to an hourly file in `data/live/` (gitignored, outside `public/` so Vite does not serve it). On startup the relay replays the files inside the retention window, so a restart keeps history. Files older than the window are deleted.
- **Raw snapshots:** optional (`--raw`), written in the same format as `record-adsb.ts`, so a live session can also become a normal recording for `extract-tracks.ts`.
- **METAR:** fetched on startup to cover the retention window plus one hour, then every 10 min. Each sample is resolved with the METAR in effect at its own time, as in replay.
- **Endpoints:**
  - `GET /api/history?from=<ms>&to=<ms>` returns `{ flights: TrackFile[], metars: RawMetar[] }` with only the samples inside the window. This is the existing `TrackFile` shape, so the replay code loads it as is. `landing` is `null` for now.
  - `GET /api/live` is a Server-Sent Events stream. After each poll it sends one `samples` event (the poll's `now`, and for each flight with new samples its ID, hex, callsign, type, and new samples), plus a `metar` event when a new METAR arrives.
  - `GET /api/status` returns the retention start, the latest data time, the last poll result, and the current backoff.

### Browser

- **Mode:** `?live` selects live mode. Without it the app plays recordings as today.
- **Startup:** fetch `/api/history` for the whole retention window, build entities as in replay, then open `/api/live`.
- **Appending samples:** a `samples` event resolves the new samples through the same path as replay (`resolveSamples`, batching all ground samples from one event into a single terrain query), appends them to each flight's position property, and extends its availability. New flights get new entities and new rows in the flight list. A sample whose time is not after that flight's last sample is dropped.
- **Orientation:** the heading logic looks at neighboring samples and checks for frozen true heading over the whole flight, so a flight's orientation property is rebuilt when samples are appended rather than appended to. At about 300 samples per flight this is cheap.
- **Live edge:** `liveEdge = serverNow - LIVE_DELAY_MS` (15 s), where `serverNow` comes from the latest event's `now` plus the time elapsed since it arrived. The delay keeps a future sample to interpolate toward, and using the relay's clock avoids skew from the viewer's clock.
- **Clock and timeline:** the clock runs from the retention start to the live edge, and its stop time advances on every tick. The timeline is re-zoomed every minute so it does not crawl.
- **LIVE button:** while following, the clock runs at 1x and its current time is pinned to the live edge. Scrubbing, pausing, or changing the speed stops following, and the replay then behaves as it does today. Reaching the live edge, or pressing LIVE, resumes following. The button shows whether the view is live.
- **Selected flight:** trails and the altitude curtain rebuild when that flight gets new samples.
- **Pruning:** once a minute, drop samples and flights older than the retention start, matching the relay.
- **Reconnect:** on an SSE error, reconnect, then fetch `/api/history?from=<latest sample time>` to fill the gap before applying new events.
- **Validation panel:** hidden in live mode for now.

## File layout (new and changed)

```
/server
  relay.ts               # poller, store, retention, persistence, HTTP + SSE
  store.ts               # in-memory flights and METARs, window queries, pruning
  sampleLog.ts           # hourly NDJSON persistence and restore
/src
  ingest.ts              # snapshot -> samples, shared with extract-tracks.ts
  ingest.test.ts
  live.ts                # history load, SSE client, append, clock, LIVE button
  replay.ts              # entities support appended samples
/scripts
  extract-tracks.ts      # uses src/ingest.ts
/data/live/*.ndjson      # gitignored, hourly sample logs
vite.config.ts           # /api proxy to the relay in dev
```

## Phases

### Phase 1: Shared ingest

- Move snapshot processing out of `extract-tracks.ts` into `src/ingest.ts`, keeping its rules unchanged.
- Unit tests cover the timestamp rule, stale and duplicate drops, gap splitting, and ID assignment (first flight gets the bare hex, later ones the first free index, existing IDs never change).

**Done when:** tests pass, and re-running `extract-tracks.ts` on the first recording produces the same samples as the committed track files. Only split flights change: `a0ad24-0` becomes `a0ad24`, and each later segment keeps its own callsign instead of the first segment's.

### Phase 2: Relay

- Poller, store, retention, hourly persistence, METAR refresh, and the three endpoints.
- `npm run relay`, plus the Vite `/api` proxy.
- Unit tests for store window queries and pruning.

**Done when:** after 10 min running, `curl /api/history` returns flights with samples covering those 10 min, `curl -N /api/live` prints a `samples` event about every 5 s, and after a restart the earlier history is still served.

**Checkpoint:** report flights and samples held, samples per poll, the size of one hour's NDJSON file, and memory use after one hour.

### Phase 3: Live view

- `?live` mode: history load, SSE append, live edge, and the LIVE button.
- The flight list and entities grow as flights appear.

**Done when:** aircraft move smoothly at the live edge without freezing or jumping, new flights appear on their own, scrubbing back an hour replays that hour, and LIVE returns to the edge.

**Checkpoint:** report how far behind real time the view runs, and confirm in the browser that the altitude and heading checks from replay still hold on live data (taxiing aircraft point along their direction of travel).

### Phase 4: Long-running behavior

- Pruning in the relay and browser, reconnect with gap fill, and selected-flight trail and curtain updates.

**Done when:** a page left open for longer than the retention window keeps steady memory use and no samples older than the window, and stopping the relay for a minute and starting it again leaves no gap in the replayed tracks.

### Phase 5 (optional): Hosting

- Deploy the relay and the built app to Railway, with a volume for `data/live/`.

## Later

- Incremental landing detection, so live flights get `landing` and the validation panel can run on live data.
- Seeding history from adsb.lol's daily archives (see `IMPROVEMENTS.md`, item 7) instead of starting empty.

## Known limits

- History starts when the relay starts. There is nothing to rewind into before that.
- The live view runs about 15 s behind real time, on top of the few seconds adsb.lol data is already aged.
- Polling gaps during 429 backoff show up as straight-line jumps, as in recordings.
