# Flight Replay PoC

Replays recorded ADS-B traffic around SFO on a 3D CesiumJS terrain globe, with altitudes converted correctly to WGS84 ellipsoid height. See `initial_plan.md` for the design.

Built with an AI coding agent (Claude Code).

## Setup

Requires Node 24+ (for the built-in `node:sqlite`) and, for the geoid grid script, [uv](https://docs.astral.sh/uv/) (it installs Python and `pyproj` on demand).

```sh
npm install
cp .env.example .env   # then set VITE_CESIUM_ION_TOKEN
npm run relay   # in another terminal: polls adsb.lol and archives traffic
npm run dev
```

## Live and archive

The relay (`server/relay.ts`) polls adsb.lol every 5 s and stores every flight in a SQLite archive (`data/archive.sqlite`, or `ARCHIVE_PATH`), kept for `RETENTION_DAYS` (default 30). Landings are detected when a flight finishes.

The page opens on live traffic. Its timeline runs from the start of the archive to now: scrubbing or zooming out loads that part of the archive an hour at a time, keeping a few hours in memory. The menu at the top left jumps to live, any archived hour, or a static recording.

- `/` live, or the latest static recording when the relay is not running
- `/?t=<ms>` the archive at that time
- `/?rec=<stamp>` a static recording from `public/data/tracks/`

## Data attribution

ADS-B data from [adsb.lol](https://adsb.lol), licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/). Weather from the [NOAA Aviation Weather Center](https://aviationweather.gov).
