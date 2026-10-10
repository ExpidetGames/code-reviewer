import { describe, expect, it } from "vitest";
import { formatDuration, runDurationMs } from "./run-duration.ts";

const NOW = new Date("2026-10-10T12:10:00.000Z");

describe("the duration of a run", () => {
  // CR-35-T07
  it("shows no duration for a waiting run", () => {
    expect(
      runDurationMs(
        { status: "queued", startedAt: null, finishedAt: null },
        NOW,
      ),
    ).toBeNull();
  });

  // CR-35-T07
  it("counts a running run from its start to the injected clock", () => {
    const run = {
      status: "running",
      startedAt: "2026-10-10T12:09:15.000Z",
      finishedAt: null,
    } as const;

    expect(runDurationMs(run, NOW)).toBe(45_000);
    expect(runDurationMs(run, new Date("2026-10-10T12:11:15.000Z"))).toBe(
      120_000,
    );
  });

  // CR-35-T07
  it("takes the difference between end and start for a finished run", () => {
    expect(
      runDurationMs(
        {
          status: "succeeded",
          startedAt: "2026-10-10T12:00:00.000Z",
          finishedAt: "2026-10-10T12:03:05.000Z",
        },
        NOW,
      ),
    ).toBe(185_000);
  });

  it("shows no duration for a run that ended without ever starting", () => {
    expect(
      runDurationMs(
        {
          status: "cancelled",
          startedAt: null,
          finishedAt: "2026-10-10T12:03:05.000Z",
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("never returns a negative or invented number", () => {
    expect(
      runDurationMs(
        {
          status: "failed",
          startedAt: "2026-10-10T12:05:00.000Z",
          finishedAt: "2026-10-10T12:00:00.000Z",
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      runDurationMs(
        { status: "running", startedAt: "not a time", finishedAt: null },
        NOW,
      ),
    ).toBeNull();
    expect(
      runDurationMs(
        {
          status: "running",
          startedAt: "2026-10-10T12:30:00.000Z",
          finishedAt: null,
        },
        NOW,
      ),
    ).toBe(0);
  });
});

describe("formatting a duration", () => {
  it("writes seconds, minutes and hours the short way", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45_900)).toBe("45 s");
    expect(formatDuration(185_000)).toBe("3 min 05 s");
    expect(formatDuration(3_720_000)).toBe("1 h 02 min");
  });
});
