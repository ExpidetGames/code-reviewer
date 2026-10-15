// SPDX-License-Identifier: Apache-2.0

// What one run of the sweep does when parts of it fail (#328): every step is tried, the ones that failed are named,
// and nothing a failure said reaches the log. The steps against a real database are in sweep.integration.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { ExpiryReport } from "../db/repositories/runner-jobs-repository.ts";
import type { CleanupResult } from "../maintenance/cleanup.ts";
import { createDispatchSweep, type SweepSettings } from "./sweep.ts";

const expiry = {
  requeued: 0,
  leaseExpired: 0,
  timedOut: 0,
  noCapableRunner: 0,
};
const cleaned = {
  rateLimits: 0,
  unverifiedAccounts: 0,
  verificationTokens: 0,
  passwordResetTokens: 0,
  jobClaimedKeys: 0,
  jobDispatches: 0,
};

function setup(options: { settings?: SweepSettings; poll?: boolean } = {}) {
  const stored = new Map<string, string>();
  const mocks = {
    expireStaleJobs: vi.fn<() => Promise<ExpiryReport>>(async () => expiry),
    failUndispatched: vi.fn<(waitedMs: number) => Promise<number>>(
      async () => 0,
    ),
    countRunning: vi.fn<() => Promise<number>>(async () => 0),
    reviveStopped: vi.fn<(before: Date, at: Date) => Promise<number>>(
      async () => 0,
    ),
    sendDue: vi.fn<(limit?: number) => Promise<{ sent: number }>>(async () => ({
      sent: 0,
    })),
    get: vi.fn<(key: string) => Promise<string | undefined>>(async (key) =>
      stored.get(key),
    ),
    set: vi.fn<(key: string, value: string) => Promise<void>>(
      async (key, value) => {
        stored.set(key, value);
      },
    ),
    cleanup: vi.fn<() => Promise<CleanupResult>>(async () => cleaned),
    retryDue: vi.fn<() => Promise<{ tried: number }>>(async () => ({
      tried: 0,
    })),
    info: vi.fn<(line: string) => void>(),
    error: vi.fn<(line: string) => void>(),
  };
  const sweep = createDispatchSweep({
    now: () => new Date("2026-10-15T12:30:00.000Z"),
    queue: {
      expireStaleJobs: mocks.expireStaleJobs,
      failUndispatched: mocks.failUndispatched,
      countRunning: mocks.countRunning,
    },
    dispatches: { reviveStopped: mocks.reviveStopped },
    ...(options.poll === true ? {} : { dispatch: { sendDue: mocks.sendDue } }),
    meta: { get: mocks.get, set: mocks.set },
    cleanup: mocks.cleanup,
    notices: { retryDue: mocks.retryDue },
    settings: options.settings ?? { giveUpMs: 3_600_000, maxRunning: null },
    log: { info: mocks.info, error: mocks.error },
  });
  return { sweep, ...mocks };
}

describe("the notices of refused reviews in a run of the sweep", () => {
  // #281-T06
  it("tries the notices that are due again and reports how many", async () => {
    const t = setup();
    t.retryDue.mockResolvedValueOnce({ tried: 3 });

    const report = await t.sweep.run();

    expect(t.retryDue).toHaveBeenCalledOnce();
    expect(report.noticesTried).toBe(3);
    expect(report.failedSteps).toEqual([]);
  });

  // #281-T06
  it("names a failed step and still does the others", async () => {
    const t = setup();
    t.retryDue.mockRejectedValueOnce(new Error("postgres://u:hunter2@db/app"));

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["notices"]);
    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=notices",
    );
  });
});

describe("a run of the sweep that partly fails", () => {
  // #328-T01
  it("still gives up, sends and cleans up when the expiry fails, and names the failed step only", async () => {
    const t = setup();
    t.expireStaleJobs.mockRejectedValueOnce(
      new Error("postgres://user:hunter2@db.example/app"),
    );

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["expire"]);
    expect(t.failUndispatched).toHaveBeenCalledWith(3_600_000);
    expect(t.sendDue).toHaveBeenCalledOnce();
    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=expire",
    );
  });

  // #328-T04
  it("does not give up when the setting is off, and still sends", async () => {
    const t = setup({ settings: { giveUpMs: null, maxRunning: null } });

    await t.sweep.run();

    expect(t.failUndispatched).not.toHaveBeenCalled();
    expect(t.sendDue).toHaveBeenCalledOnce();
  });

  // #328-T08
  it.each([
    ["nothing at the cap", 3, 3, undefined],
    ["nothing over the cap", 3, 5, undefined],
    ["the difference below it", 3, 1, 2],
    ["never more than the default batch", 1000, 0, 20],
  ])("keeps to the free slots: %s", async (_, cap, running, expected) => {
    const t = setup({ settings: { giveUpMs: null, maxRunning: cap } });
    t.countRunning.mockResolvedValue(running);

    await t.sweep.run();

    if (expected === undefined) expect(t.sendDue).not.toHaveBeenCalled();
    else expect(t.sendDue).toHaveBeenCalledWith(expected);
  });

  // #328-T09
  it("does not revive, count or send in poll mode", async () => {
    const t = setup({
      poll: true,
      settings: { giveUpMs: null, maxRunning: 3 },
    });

    await t.sweep.run();

    expect(t.reviveStopped).not.toHaveBeenCalled();
    expect(t.sendDue).not.toHaveBeenCalled();
    expect(t.countRunning).not.toHaveBeenCalled();
  });

  // #328-T11
  it("treats an hour it cannot read as never cleaned and cleans again", async () => {
    const t = setup();
    t.get.mockResolvedValue("not a number");

    const report = await t.sweep.run();

    expect(report.cleanedUp).toBe(true);
    expect(t.set).toHaveBeenCalledWith(
      "maintenance.sweep_cleanup_hour",
      String(Math.floor(Date.parse("2026-10-15T12:30:00.000Z") / 3_600_000)),
    );
  });

  // #328-T11
  it("does not clean up twice in an hour", async () => {
    const t = setup();

    await t.sweep.run();
    const second = await t.sweep.run();

    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(second.cleanedUp).toBe(false);
  });
});
