import { describe, expect, it } from "vitest";
import { CHUNK_MS, type LoadWindow, MAX_WINDOW_MS, missingRanges, nextWindow, overlaps } from "./liveWindow";

const MIN = 60_000;
const HOUR = 60 * MIN;
const EDGE = 100 * HOUR;
const ARCHIVE_START = 0;

const attached = (fromMs: number): LoadWindow => ({ fromMs, toMs: EDGE, attached: true });
const detached = (fromMs: number, toMs: number): LoadWindow => ({ fromMs, toMs, attached: false });

describe("nextWindow", () => {
  it("keeps the window while the clock is well inside it", () => {
    expect(nextWindow(attached(EDGE - HOUR), EDGE - 30 * MIN, EDGE, ARCHIVE_START)).toBeNull();
    expect(nextWindow(detached(10 * HOUR, 12 * HOUR), 11 * HOUR, EDGE, ARCHIVE_START)).toBeNull();
  });

  it("extends backward by a chunk as the clock nears the start", () => {
    expect(nextWindow(attached(EDGE - HOUR), EDGE - HOUR + 5 * MIN, EDGE, ARCHIVE_START)).toEqual(attached(EDGE - 2 * HOUR));
  });

  it("stops extending at the start of the archive", () => {
    expect(nextWindow(detached(0, 2 * HOUR), 5 * MIN, EDGE, ARCHIVE_START)).toBeNull();
    expect(nextWindow(detached(0.5 * HOUR, 2 * HOUR), 0.5 * HOUR, EDGE, ARCHIVE_START)).toEqual(detached(0, 2 * HOUR));
  });

  it("extends a detached window forward, and attaches once it reaches the live edge", () => {
    expect(nextWindow(detached(10 * HOUR, 12 * HOUR), 12 * HOUR - 5 * MIN, EDGE, ARCHIVE_START)).toEqual(
      detached(10 * HOUR, 13 * HOUR),
    );
    expect(nextWindow(detached(EDGE - 2 * HOUR, EDGE - 0.5 * HOUR), EDGE - 0.6 * HOUR, EDGE, ARCHIVE_START)).toEqual(
      attached(EDGE - 2 * HOUR),
    );
  });

  it("jumps to a window around a far-away clock", () => {
    expect(nextWindow(attached(EDGE - HOUR), 50 * HOUR, EDGE, ARCHIVE_START)).toEqual(detached(50 * HOUR - 30 * MIN, 51 * HOUR));
  });

  it("attaches when jumping back to the live edge", () => {
    expect(nextWindow(detached(10 * HOUR, 12 * HOUR), EDGE, EDGE, ARCHIVE_START)).toEqual(attached(EDGE - 30 * MIN));
  });

  it("detaches when extending back past the maximum span, dropping the live end", () => {
    const next = nextWindow(attached(EDGE - MAX_WINDOW_MS), EDGE - MAX_WINDOW_MS + 5 * MIN, EDGE, ARCHIVE_START);
    expect(next).toEqual(detached(EDGE - MAX_WINDOW_MS - CHUNK_MS, EDGE - CHUNK_MS));
  });

  it("trims an attached window's start as the live edge moves on", () => {
    expect(nextWindow(attached(EDGE - MAX_WINDOW_MS - 2 * CHUNK_MS), EDGE - MIN, EDGE, ARCHIVE_START)).toEqual(
      attached(EDGE - MAX_WINDOW_MS),
    );
  });

  it("detaches instead when the clock is back near the start of a grown window", () => {
    const fromMs = EDGE - MAX_WINDOW_MS - 2 * CHUNK_MS;
    expect(nextWindow(attached(fromMs), fromMs + 30 * MIN, EDGE, ARCHIVE_START)).toEqual(detached(fromMs, fromMs + MAX_WINDOW_MS));
  });
});

describe("missingRanges", () => {
  it("fetches only the new chunk when extending backward", () => {
    expect(missingRanges(attached(EDGE - HOUR), attached(EDGE - 2 * HOUR), EDGE)).toEqual([
      { fromMs: EDGE - 2 * HOUR, toMs: EDGE - HOUR },
    ]);
  });

  it("fetches only the new chunk when extending forward", () => {
    expect(missingRanges(detached(10 * HOUR, 12 * HOUR), detached(10 * HOUR, 13 * HOUR), EDGE)).toEqual([
      { fromMs: 12 * HOUR, toMs: 13 * HOUR },
    ]);
  });

  it("fetches up to the latest data when attaching", () => {
    expect(missingRanges(detached(EDGE - 2 * HOUR, EDGE - 0.5 * HOUR), attached(EDGE - 2 * HOUR), EDGE)).toEqual([
      { fromMs: EDGE - 0.5 * HOUR, toMs: null },
    ]);
  });

  it("fetches the whole window after a jump", () => {
    expect(missingRanges(attached(EDGE - HOUR), detached(50 * HOUR, 51 * HOUR), EDGE)).toEqual([{ fromMs: 50 * HOUR, toMs: 51 * HOUR }]);
    expect(missingRanges(detached(10 * HOUR, 12 * HOUR), attached(EDGE - 30 * MIN), EDGE)).toEqual([
      { fromMs: EDGE - 30 * MIN, toMs: null },
    ]);
  });

  it("fetches nothing when only trimming", () => {
    expect(missingRanges(attached(EDGE - 6 * HOUR), attached(EDGE - 4 * HOUR), EDGE)).toEqual([]);
  });
});

describe("overlaps", () => {
  it("treats an attached window as open-ended", () => {
    expect(overlaps(attached(EDGE - HOUR), EDGE + HOUR, EDGE + 2 * HOUR)).toBe(true);
    expect(overlaps(detached(0, HOUR), 2 * HOUR, 3 * HOUR)).toBe(false);
    expect(overlaps(detached(HOUR, 2 * HOUR), 0, 0.5 * HOUR)).toBe(false);
  });
});
