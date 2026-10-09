// Which part of the relay's archive live mode keeps loaded. The timeline spans the whole
// archive, but only a window of a few hours around the clock is held. An attached window
// reaches the live edge and grows with each poll; a detached one is a fixed span in the past.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const CHUNK_MS = HOUR_MS; // loaded at a time when the clock nears the window's edge
export const MAX_WINDOW_MS = 4 * HOUR_MS; // more than this drops the side farther from the clock
const EXTEND_MARGIN_MS = 10 * MINUTE_MS; // extend once the clock is this close to an edge
const JUMP_BEFORE_MS = 30 * MINUTE_MS; // a jump loads this much before the target, and a chunk after

export interface LoadWindow {
  fromMs: number;
  toMs: number; // ignored while attached: the window then ends at the live edge
  attached: boolean;
}

/** A span to fetch from the archive. `toMs` null means up to the latest data. */
export interface FetchRange {
  fromMs: number;
  toMs: number | null;
}

const endMs = (win: LoadWindow, edgeMs: number) => (win.attached ? edgeMs : win.toMs);

/**
 * The window to hold so the clock at `tMs` stays covered, or null if the current one will do.
 * Far from the window, a new one is loaded around the clock; near an edge, the window grows
 * by a chunk; and it never spans more than MAX_WINDOW_MS.
 */
export function nextWindow(win: LoadWindow, tMs: number, edgeMs: number, archiveStartMs: number): LoadWindow | null {
  const toMs = endMs(win, edgeMs);
  let fromMs: number;
  let nextToMs: number;
  if (tMs < win.fromMs - CHUNK_MS || tMs > toMs + CHUNK_MS) {
    fromMs = tMs - JUMP_BEFORE_MS;
    nextToMs = tMs + CHUNK_MS;
  } else if (tMs < win.fromMs + EXTEND_MARGIN_MS && win.fromMs > archiveStartMs) {
    fromMs = win.fromMs - CHUNK_MS;
    nextToMs = toMs;
  } else if (!win.attached && tMs > toMs - EXTEND_MARGIN_MS) {
    fromMs = win.fromMs;
    nextToMs = toMs + CHUNK_MS;
  } else if (win.attached && edgeMs - win.fromMs > MAX_WINDOW_MS + CHUNK_MS) {
    // The live edge has moved on; trimmed below.
    fromMs = win.fromMs;
    nextToMs = edgeMs;
  } else {
    return null;
  }

  fromMs = Math.max(fromMs, archiveStartMs);
  let attached = nextToMs >= edgeMs;
  const spanEndMs = attached ? edgeMs : nextToMs;
  if (spanEndMs - fromMs > MAX_WINDOW_MS) {
    if (tMs - fromMs < spanEndMs - tMs) {
      nextToMs = fromMs + MAX_WINDOW_MS;
      attached = false;
    } else {
      fromMs = spanEndMs - MAX_WINDOW_MS;
    }
  }
  return { fromMs, toMs: attached ? edgeMs : nextToMs, attached };
}

/** What `next` holds that `prev` does not. Live events fill an attached window's end. */
export function missingRanges(prev: LoadWindow, next: LoadWindow, edgeMs: number): FetchRange[] {
  const prevToMs = endMs(prev, edgeMs);
  const nextTo = next.attached ? null : next.toMs;
  if (next.fromMs > prevToMs || (nextTo !== null && nextTo < prev.fromMs)) return [{ fromMs: next.fromMs, toMs: nextTo }];
  const ranges: FetchRange[] = [];
  if (next.fromMs < prev.fromMs) ranges.push({ fromMs: next.fromMs, toMs: prev.fromMs });
  if (!prev.attached && (nextTo === null || nextTo > prevToMs)) ranges.push({ fromMs: prevToMs, toMs: nextTo });
  return ranges;
}

/** Whether a flight spanning [startMs, stopMs] overlaps the window. */
export function overlaps(win: LoadWindow, startMs: number, stopMs: number): boolean {
  return stopMs >= win.fromMs && (win.attached || startMs <= win.toMs);
}
