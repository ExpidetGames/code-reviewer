// SPDX-License-Identifier: Apache-2.0

// What the production server does about old rows: clean up when it starts and then every hour
// (cleanup.ts). Called from `src/instrumentation.ts`. Other environments (the dev server, tests) run no
// timer. A failing run is logged by its code and tried again at the next hour; it never stops the app.
import "server-only";
import { releaseStrandedHoldsWhileBillingOn } from "../billing/stranded-holds.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import { cleanUpExpiredRows, type CleanupResult } from "./cleanup.ts";

export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export type CleanupTimer = { stop: () => void };

type StartOptions = {
  run?: () => Promise<CleanupResult>;
  /** #591: releases the holds of jobs that ended while billing was off, while billing is on. Not given: see `startCleanup`. */
  releaseHolds?: () => Promise<{ released: number }>;
  /** #506: mails the balance crossings that are due, which a settlement without a hook of its own left. Not given: see `startCleanup`. */
  deliverBalanceMails?: () => Promise<unknown>;
  /** Calls `callback` every `intervalMs`; returns a function that cancels it. */
  setTimer?: (callback: () => void, intervalMs: number) => () => void;
  log?: Pick<Console, "info" | "error">;
};

function defaultSetTimer(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  // A timer must not keep the process alive.
  timer.unref();
  return () => clearInterval(timer);
}

function releaseHoldsOfEndedJobs(): Promise<{ released: number }> {
  return releaseStrandedHoldsWhileBillingOn(getDatabase(), () => new Date());
}

async function deliverBalanceMailsOfServer(): Promise<unknown> {
  // Loaded when it runs: the delivery brings the whole billing wiring, which the timer does not need until then.
  return (await import("../billing/shared.ts")).deliverDueBalanceMailsNow();
}

/**
 * Runs the cleanup now and again at every interval, and then the release of the holds of ended jobs (#591: with billing on,
 * a job that ended in the moment billing was switched on is not seen by the switch-on). The real cleanup comes with the real
 * release and the delivery of the due balance mails (#506); a `run` that is handed in (a test) comes without them unless a
 * `releaseHolds` or a `deliverBalanceMails` is handed in too.
 */
export function startCleanup({
  run,
  releaseHolds = run === undefined ? releaseHoldsOfEndedJobs : undefined,
  deliverBalanceMails = run === undefined
    ? deliverBalanceMailsOfServer
    : undefined,
  setTimer = defaultSetTimer,
  log = console,
}: StartOptions = {}): CleanupTimer {
  const cleanUp =
    run ??
    (() =>
      cleanUpExpiredRows(getDatabase(), undefined, {
        // Read when it matters, never remembered: the admin can add or remove the mail server at any time.
        mailConfigured: () => getMailSender().isConfigured(),
      }));
  const once = async (): Promise<void> => {
    try {
      const removed = await cleanUp();
      if (
        removed.rateLimits +
          removed.unverifiedAccounts +
          removed.verificationTokens +
          removed.passwordResetTokens +
          removed.jobClaimedKeys +
          removed.jobDispatches >
        0
      )
        log.info(
          `[maintenance] removed ${String(removed.rateLimits)} old rate limit counters, ${String(removed.unverifiedAccounts)} unverified accounts, ${String(removed.verificationTokens)} old verification links and ${String(removed.passwordResetTokens)} old reset links and ${String(removed.jobClaimedKeys)} remembered job keys and ${String(removed.jobDispatches)} dispatch rows.`,
        );
    } catch {
      log.error(
        "[maintenance] CLEANUP_FAILED: old rows could not be removed; trying again at the next hour.",
      );
    }
    if (releaseHolds !== undefined)
      try {
        await releaseHolds();
      } catch {
        log.error(
          "[maintenance] BILLING_HOLDS_SWEEP_FAILED: the holds of ended jobs could not be released; trying again at the next hour.",
        );
      }
    if (deliverBalanceMails !== undefined)
      try {
        await deliverBalanceMails();
      } catch {
        log.error(
          "[maintenance] BALANCE_MAILS_SWEEP_FAILED: the due balance mails could not be sent; trying again at the next hour.",
        );
      }
  };
  void once();
  return { stop: setTimer(() => void once(), CLEANUP_INTERVAL_MS) };
}

export function startCleanupOnStart({
  env = process.env,
  ...options
}: StartOptions & {
  env?: Readonly<Record<string, string | undefined>>;
} = {}): CleanupTimer | null {
  if (env.NODE_ENV !== "production") return null;
  return startCleanup(options);
}
