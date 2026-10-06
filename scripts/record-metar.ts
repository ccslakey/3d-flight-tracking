// Fetches KSFO METARs covering an ADS-B recording, plus at least one hour before it,
// and saves the raw API objects. Parsing happens in src/metar.ts.
// Usage: tsx scripts/record-metar.ts public/data/raw/adsb-<stamp>.ndjson

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const USER_AGENT = "flight-tracker-poc/0.1 (ADS-B replay research)";
const LEAD_SEC = 3600;

const adsbPath = process.argv[2];
if (!adsbPath) throw new Error("Usage: tsx scripts/record-metar.ts <adsb ndjson>");

const lines = readFileSync(adsbPath, "utf8").trim().split("\n");
const firstMs = JSON.parse(lines[0]).now as number;
const lastMs = JSON.parse(lines[lines.length - 1]).now as number;

// `hours` counts back from now, so cover from (start - lead) to now.
const hours = Math.ceil((Date.now() / 1000 - (firstMs / 1000 - LEAD_SEC)) / 3600) + 1;
const url = `https://aviationweather.gov/api/data/metar?ids=KSFO&format=json&hours=${hours}`;
const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
const all = (await res.json()) as { obsTime: number }[];

const fromSec = firstMs / 1000 - LEAD_SEC;
const toSec = lastMs / 1000;
const metars = all.filter((m) => m.obsTime >= fromSec && m.obsTime <= toSec).sort((a, b) => a.obsTime - b.obsTime);

if (!metars.length || metars[0].obsTime > firstMs / 1000) {
  throw new Error("No METAR at or before the first ADS-B snapshot; widen the window");
}

const outPath = join("public", "data", basename(adsbPath).replace(/^adsb-/, "metar-").replace(/\.ndjson$/, ".json"));
writeFileSync(outPath, JSON.stringify(metars, null, 1));
console.log(`${metars.length} METARs written to ${outPath}`);
