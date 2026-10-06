# Flight Replay PoC

Replays recorded ADS-B traffic around SFO on a 3D CesiumJS terrain globe, with altitudes converted correctly to WGS84 ellipsoid height. See `initial_plan.md` for the design.

Built with an AI coding agent (Claude Code).

## Setup

Requires Node 22+ and, for the geoid grid script, Python 3 with `pyproj`.

```sh
npm install
cp .env.example .env   # then set VITE_CESIUM_ION_TOKEN
npm run dev
```

## Data attribution

ADS-B data from [adsb.lol](https://adsb.lol), licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/). Weather from the [NOAA Aviation Weather Center](https://aviationweather.gov).
