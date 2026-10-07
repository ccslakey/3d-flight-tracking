// Live-mode panel showing whether data is flowing: the page's event stream, the relay, the
// relay's adsb.lol polling, and how old the latest data is.

import type { LiveFeed } from "./live";

const STATUS_POLL_MS = 5_000;
const RENDER_MS = 1_000;
// Data older than this is past what the live view hides (15 s delay plus 30 s hold).
const DATA_WARN_S = 20;
const DATA_BAD_S = 45;
const STREAM_SILENT_S = 20;
const STREAM_BAD_S = 60;

type Level = "ok" | "warn" | "bad";

interface RelayStatus {
  nowMs: number;
  latestNowMs: number | null;
  lastPoll: { atMs: number; ok: boolean; error: string | null };
  backoffMs: number;
}

const LEVEL_RANK: Record<Level, number> = { ok: 0, warn: 1, bad: 2 };
const worst = (levels: Level[]): Level => levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), "ok");
const secondsText = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

export function createConnectionPanel(feed: LiveFeed): void {
  const panel = document.createElement("div");
  panel.className = "connection-panel";
  const title = document.createElement("div");
  title.className = "connection-title";
  const rows = document.createElement("div");
  panel.append(title, rows);
  document.body.append(panel);

  let status: RelayStatus | null = null;
  let fetchedAtMs = 0;
  let relayError: string | null = null;

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status = (await res.json()) as RelayStatus;
      fetchedAtMs = Date.now();
      relayError = null;
    } catch (err) {
      relayError = (err as Error).message;
    }
    render();
  }

  function row(level: Level, label: string, value: string): [Level, HTMLElement] {
    const el = document.createElement("div");
    el.className = `connection-row is-${level}`;
    const name = document.createElement("span");
    name.textContent = label;
    const text = document.createElement("span");
    text.textContent = value;
    el.append(name, text);
    return [level, el];
  }

  function render(): void {
    const items: [Level, HTMLElement][] = [];

    const stream = feed.stream();
    const silentS = (Date.now() - stream.lastHeardMs) / 1000;
    // An open stream can still be hung, so also require recent messages (the relay pings every 15 s).
    if (stream.open && silentS < STREAM_SILENT_S) items.push(row("ok", "Stream", "Connected"));
    else {
      const what = stream.open ? "Silent" : "Reconnecting";
      items.push(row(silentS > STREAM_BAD_S ? "bad" : "warn", "Stream", `${what} for ${secondsText(silentS)}`));
    }

    if (relayError || !status) {
      items.push(row("bad", "Relay", relayError ? `Unreachable (${relayError})` : "Checking…"));
    } else {
      // Relay clock, advanced by the time since the status was fetched.
      const relayNowMs = status.nowMs + (Date.now() - fetchedAtMs);
      const { lastPoll, backoffMs, latestNowMs } = status;
      if (lastPoll.ok) {
        items.push(row("ok", "adsb.lol", "Polling"));
      } else if (!lastPoll.atMs) {
        items.push(row("warn", "adsb.lol", "Starting"));
      } else {
        const retryS = Math.max(0, (lastPoll.atMs + backoffMs - relayNowMs) / 1000);
        const what = lastPoll.error === "HTTP 429" ? "Rate limited" : `Failing (${lastPoll.error})`;
        items.push(row(backoffMs >= 40_000 ? "bad" : "warn", "adsb.lol", `${what}, retry in ${secondsText(retryS)}`));
      }
      if (latestNowMs === null) {
        items.push(row("warn", "Latest data", "None yet"));
      } else {
        const ageS = (relayNowMs - latestNowMs) / 1000;
        const level: Level = ageS >= DATA_BAD_S ? "bad" : ageS >= DATA_WARN_S ? "warn" : "ok";
        items.push(row(level, "Latest data", `${secondsText(ageS)} old`));
      }
    }

    const overall = worst(items.map(([level]) => level));
    panel.className = `connection-panel is-${overall}`;
    title.textContent = { ok: "Live data", warn: "Live data delayed", bad: "Live data interrupted" }[overall];
    rows.replaceChildren(...items.map(([, el]) => el));
  }

  void refresh();
  setInterval(refresh, STATUS_POLL_MS);
  setInterval(render, RENDER_MS);
}
