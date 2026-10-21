// SPDX-License-Identifier: Apache-2.0

// Pins down when the cleanup runs: in production at the start and at every interval, never elsewhere, and a
// failing run is logged by its code and does not stop the timer.
import { describe, expect, it, vi } from "vitest";
import { runJournalCheckWhileBillingOn } from "../billing/journal-check.ts";
import { releaseStrandedHoldsWhileBillingOn } from "../billing/stranded-holds.ts";
import {
  CLEANUP_INTERVAL_MS,
  startCleanup,
  startCleanupOnStart,
} from "./startup.ts";

// The release the timer runs for a real server (#591) is observed, never run: T18 asserts it is not called for a test run.
vi.mock("../billing/stranded-holds.ts", () => ({
  releaseStrandedHoldsWhileBillingOn: vi.fn(async () => ({ released: 0 })),
}));

// The check the timer runs for a real server (#626) is observed, never run.
vi.mock("../billing/journal-check.ts", () => ({
  runJournalCheckWhileBillingOn: vi.fn(async () => ({
    skipped: "off",
    checked: 0,
    finished: false,
  })),
}));

function fixture(
  run: () => Promise<{
    rateLimits: number;
    unverifiedAccounts: number;
    verificationTokens: number;
    passwordResetTokens: number;
    jobClaimedKeys: number;
    jobDispatches: number;
  }>,
) {
  let fire: () => void = () => undefined;
  const stopped = vi.fn();
  const setTimer = vi.fn((callback: () => void) => {
    fire = callback;
    return stopped;
  });
  const log = { info: vi.fn(), error: vi.fn() };
  return { run: vi.fn(run), setTimer, log, tick: () => fire(), stopped };
}

describe("the cleanup timer", () => {
  it("runs once at the start and then at every tick, every hour", async () => {
    const f = fixture(() =>
      Promise.resolve({
        rateLimits: 0,
        unverifiedAccounts: 0,
        verificationTokens: 0,
        passwordResetTokens: 0,
        jobClaimedKeys: 0,
        jobDispatches: 0,
      }),
    );

    startCleanup(f);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));

    expect(f.setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      CLEANUP_INTERVAL_MS,
    );
    expect(CLEANUP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("says how many rows it removed, and says nothing when there were none", async () => {
    const some = fixture(() =>
      Promise.resolve({
        rateLimits: 3,
        unverifiedAccounts: 2,
        verificationTokens: 1,
        passwordResetTokens: 0,
        jobClaimedKeys: 0,
        jobDispatches: 0,
      }),
    );
    const none = fixture(() =>
      Promise.resolve({
        rateLimits: 0,
        unverifiedAccounts: 0,
        verificationTokens: 0,
        passwordResetTokens: 0,
        jobClaimedKeys: 0,
        jobDispatches: 0,
      }),
    );

    startCleanup(some);
    startCleanup(none);
    await vi.waitFor(() => expect(some.log.info).toHaveBeenCalledTimes(1));

    expect(String(some.log.info.mock.calls[0]?.[0])).toContain(
      "3 old rate limit counters, 2 unverified accounts, 1 old verification links and 0 old reset links",
    );
    expect(none.log.info).not.toHaveBeenCalled();
  });

  it("logs a failure by its code, keeps the timer and tries again", async () => {
    let calls = 0;
    const f = fixture(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("secret detail"))
        : Promise.resolve({
            rateLimits: 0,
            unverifiedAccounts: 0,
            verificationTokens: 0,
            passwordResetTokens: 0,
            jobClaimedKeys: 0,
            jobDispatches: 0,
          });
    });

    startCleanup(f);
    await vi.waitFor(() => expect(f.log.error).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));

    expect(String(f.log.error.mock.calls[0]?.[0])).toContain("CLEANUP_FAILED");
    expect(String(f.log.error.mock.calls[0]?.[0])).not.toContain(
      "secret detail",
    );
  });

  it("stops the timer", () => {
    const f = fixture(() =>
      Promise.resolve({
        rateLimits: 0,
        unverifiedAccounts: 0,
        verificationTokens: 0,
        passwordResetTokens: 0,
        jobClaimedKeys: 0,
        jobDispatches: 0,
      }),
    );

    startCleanup(f).stop();

    expect(f.stopped).toHaveBeenCalledTimes(1);
  });

  it("runs only in production", () => {
    const f = fixture(() =>
      Promise.resolve({
        rateLimits: 0,
        unverifiedAccounts: 0,
        verificationTokens: 0,
        passwordResetTokens: 0,
        jobClaimedKeys: 0,
        jobDispatches: 0,
      }),
    );

    expect(
      startCleanupOnStart({ env: { NODE_ENV: "development" }, ...f }),
    ).toBeNull();
    expect(startCleanupOnStart({ env: {}, ...f })).toBeNull();
    expect(f.setTimer).not.toHaveBeenCalled();
    expect(
      startCleanupOnStart({ env: { NODE_ENV: "production" }, ...f }),
    ).not.toBeNull();
    expect(f.setTimer).toHaveBeenCalledTimes(1);
  });
});

describe("the release of the holds of ended jobs on the timer (#591)", () => {
  const nothingRemoved = () =>
    Promise.resolve({
      rateLimits: 0,
      unverifiedAccounts: 0,
      verificationTokens: 0,
      passwordResetTokens: 0,
      jobClaimedKeys: 0,
      jobDispatches: 0,
    });

  // #591-T16
  it("releases at the start and at every tick, after the cleanup", async () => {
    const f = fixture(nothingRemoved);
    const releaseHolds = vi.fn(async () => ({ released: 0 }));

    startCleanup({ ...f, releaseHolds });
    await vi.waitFor(() => expect(releaseHolds).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(releaseHolds).toHaveBeenCalledTimes(2));

    expect(f.run.mock.invocationCallOrder[0]).toBeLessThan(
      releaseHolds.mock.invocationCallOrder[0] ?? 0,
    );
  });

  // #591-T17
  it("names a failed release by its code, without what the database said, and still runs at the next tick", async () => {
    const f = fixture(nothingRemoved);
    const releaseHolds = vi
      .fn<() => Promise<{ released: number }>>()
      .mockRejectedValueOnce(new Error("postgres://u:hunter2@db/app"))
      .mockResolvedValue({ released: 0 });

    startCleanup({ ...f, releaseHolds });
    await vi.waitFor(() => expect(f.log.error).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(releaseHolds).toHaveBeenCalledTimes(2));

    expect(f.log.error.mock.calls[0]?.[0]).toContain(
      "BILLING_HOLDS_SWEEP_FAILED",
    );
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain("hunter2");
  });

  // #591-T18
  it("releases even when the cleanup failed, and does not release when no release is given with a test run", async () => {
    const failing = fixture(() => Promise.reject(new Error("no")));
    const releaseHolds = vi.fn(async () => ({ released: 0 }));
    startCleanup({ ...failing, releaseHolds });
    await vi.waitFor(() => expect(releaseHolds).toHaveBeenCalledTimes(1));

    const plain = fixture(nothingRemoved);
    startCleanup(plain);
    await vi.waitFor(() => expect(plain.run).toHaveBeenCalledTimes(1));
    // The run has finished once the next macrotask starts: nothing was left to wait for, and nothing released.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseStrandedHoldsWhileBillingOn).not.toHaveBeenCalled();
    expect(plain.log.error).not.toHaveBeenCalled();
  });
});

describe("the delivery of balance mails on the timer (#506)", () => {
  const nothingRemoved = () =>
    Promise.resolve({
      rateLimits: 0,
      unverifiedAccounts: 0,
      verificationTokens: 0,
      passwordResetTokens: 0,
      jobClaimedKeys: 0,
      jobDispatches: 0,
    });

  // #506-T17
  it("delivers at the start and at every tick, after the cleanup", async () => {
    const f = fixture(nothingRemoved);
    const deliverBalanceMails = vi.fn(async () => undefined);

    startCleanup({ ...f, deliverBalanceMails });
    await vi.waitFor(() =>
      expect(deliverBalanceMails).toHaveBeenCalledTimes(1),
    );
    f.tick();
    await vi.waitFor(() =>
      expect(deliverBalanceMails).toHaveBeenCalledTimes(2),
    );

    expect(f.run.mock.invocationCallOrder[0]).toBeLessThan(
      deliverBalanceMails.mock.invocationCallOrder[0] ?? 0,
    );
  });

  // #506-T17
  it("names a failed delivery by its code, without what it said, and still runs at the next tick", async () => {
    const f = fixture(nothingRemoved);
    const deliverBalanceMails = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("postgres://u:hunter2@db/app"))
      .mockResolvedValue(undefined);

    startCleanup({ ...f, deliverBalanceMails });
    await vi.waitFor(() => expect(f.log.error).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() =>
      expect(deliverBalanceMails).toHaveBeenCalledTimes(2),
    );

    expect(String(f.log.error.mock.calls[0]?.[0])).toContain(
      "BALANCE_MAILS_SWEEP_FAILED",
    );
    expect(String(f.log.error.mock.calls[0]?.[0])).not.toContain("hunter2");
  });
});

describe("the check of the journal on the timer (#626)", () => {
  const nothingRemoved = () =>
    Promise.resolve({
      rateLimits: 0,
      unverifiedAccounts: 0,
      verificationTokens: 0,
      passwordResetTokens: 0,
      jobClaimedKeys: 0,
      jobDispatches: 0,
    });

  // #626-T16
  it("checks at the start and at every tick, after the cleanup", async () => {
    const f = fixture(nothingRemoved);
    const checkJournal = vi.fn(async () => undefined);

    startCleanup({ ...f, checkJournal });
    await vi.waitFor(() => expect(checkJournal).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(checkJournal).toHaveBeenCalledTimes(2));

    expect(f.run.mock.invocationCallOrder[0]).toBeLessThan(
      checkJournal.mock.invocationCallOrder[0] ?? 0,
    );
  });

  // #626-T16
  it("names a failed check by its code, without what it said, and still runs at the next tick", async () => {
    const f = fixture(nothingRemoved);
    const checkJournal = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("postgres://u:hunter2@db/app"))
      .mockResolvedValue(undefined);

    startCleanup({ ...f, checkJournal });
    await vi.waitFor(() => expect(f.log.error).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(checkJournal).toHaveBeenCalledTimes(2));

    expect(String(f.log.error.mock.calls[0]?.[0])).toContain(
      "BILLING_JOURNAL_CHECK_FAILED",
    );
    expect(String(f.log.error.mock.calls[0]?.[0])).not.toContain("hunter2");
  });

  // #626-T16
  it("does not check in a test run that hands in its own cleanup", async () => {
    const plain = fixture(nothingRemoved);
    startCleanup(plain);
    await vi.waitFor(() => expect(plain.run).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runJournalCheckWhileBillingOn).not.toHaveBeenCalled();
    expect(plain.log.error).not.toHaveBeenCalled();
  });
});
