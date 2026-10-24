// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  STOP_RETRY_WINDOW_SECONDS,
  VM_END_SOURCES,
  backstopEnd,
  billableMinutes,
  boundedEnd,
} from "./minutes.ts";

const START = new Date("2026-10-19T10:00:00.000Z");
const after = (seconds: number) => new Date(START.getTime() + seconds * 1000);

describe("billableMinutes", () => {
  // #493-T01
  it("counts every started minute, at least one once a VM exists", () => {
    const minutes = [0, 1, 59, 60, 61, 3600].map((seconds) =>
      billableMinutes({ startedAt: START, endedAt: after(seconds) }),
    );
    expect(minutes).toStrictEqual([1, 1, 1, 1, 2, 60]);
  });

  // #493-T01
  it("is 0 when no VM or Worker ever started", () => {
    expect(billableMinutes({ startedAt: null, endedAt: after(90) })).toBe(0);
  });

  // #493-T01
  it("rounds a fraction of a second up and reads an end before the start as 0 seconds", () => {
    expect(billableMinutes({ startedAt: START, endedAt: after(60.001) })).toBe(
      2,
    );
    expect(billableMinutes({ startedAt: START, endedAt: after(-30) })).toBe(1);
  });
});

describe("backstopEnd", () => {
  // #493-T07
  it("is the job's end plus the stop-retry window when that is before the VM timeout", () => {
    expect(
      backstopEnd({
        startedAt: START,
        timeoutSeconds: 3000,
        jobEndedAt: after(600),
      }),
    ).toStrictEqual(after(600 + STOP_RETRY_WINDOW_SECONDS));
  });

  // #493-T07
  it("is cut at start plus the VM timeout, so a missing teardown never bills more than the VM can live", () => {
    expect(
      backstopEnd({
        startedAt: START,
        timeoutSeconds: 1000,
        jobEndedAt: after(990),
      }),
    ).toStrictEqual(after(1000));
  });

  // #493-T07
  it("counts from the start when the job ended before the VM was reported (a cancel during the launch)", () => {
    expect(
      backstopEnd({
        startedAt: START,
        timeoutSeconds: 3000,
        jobEndedAt: after(-5),
      }),
    ).toStrictEqual(after(STOP_RETRY_WINDOW_SECONDS));
  });
});

describe("boundedEnd", () => {
  // #493-T06
  it("keeps a confirmed end between the start and start plus the VM timeout", () => {
    expect(
      boundedEnd({ startedAt: START, timeoutSeconds: 1000, at: after(400) }),
    ).toStrictEqual(after(400));
    expect(
      boundedEnd({ startedAt: START, timeoutSeconds: 1000, at: after(5000) }),
    ).toStrictEqual(after(1000));
    expect(
      boundedEnd({ startedAt: START, timeoutSeconds: 1000, at: after(-9) }),
    ).toStrictEqual(START);
  });
});

describe("the end sources", () => {
  // #493-T09
  // #498-B1: two more, so that a hosted job whose VM was never reported is flagged and never priced at zero silently.
  it("are the three of ADR 0006 (2.11) that end a run, and the two of #498 for a VM nobody reported", () => {
    expect([...VM_END_SOURCES]).toStrictEqual([
      "app_stop_confirmed",
      "timeout_backstop",
      "job_wall_clock",
      "app_stop_unreported",
      "claim_wall_clock",
    ]);
  });
});
