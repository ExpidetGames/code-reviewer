// SPDX-License-Identifier: Apache-2.0

// One run of the cron sweep of a hosted deployment (#328). In a serverless deployment nothing polls and no
// process lives long enough to hold a timer, so the clock is this run, called once a minute by the platform's
// cron (src/cron/dispatch-sweep.ts, which also makes sure two runs never overlap). Per run, in this order:
//
//  1. `expire`: lapsed leases put back in the queue (or failed on the last attempt), jobs past the hard limit
//     failed with `timeout`: what a claim does first, for a deployment in which nobody claims often.
//  2. `give_up`: a job that has waited for a claim longer than the give-up time fails with
//     `dispatch_unavailable`, so a queued review never waits for ever when the Dispatcher is gone. Off in poll
//     mode unless the operator sets `RUNNER_DISPATCH_GIVE_UP_SECONDS` (settings.ts).
//  3. `revive`: a dispatch that the Dispatcher stopped (`not_capable`) is looked at again after
//     `STOPPED_REVIVE_MS`: the Dispatcher may have been updated or its engines may be back.
//  4. `send`: the jobs that are due and not yet called, or whose call is due again, within the pool cap
//     (`RUNNER_DISPATCH_MAX_RUNNING`): at most as many as there are free slots.
//  5. `notices`: the notices of refused reviews whose post failed and whose wait is over (#281), at most one
//     batch, each tried a few times at most.
//  6. `cleanup`: the hourly cleanup a long-lived server runs on a timer, once when the hour has changed.
//
// A step that fails is logged by its name and does not stop the others; the next run tries again. Nothing a
// database or an answer said is ever logged: a connection string can be in it.
import "server-only";
import type { AppMetaRepository } from "../db/repositories/app-meta-repository.ts";
import type { JobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import type { ExpiryReport } from "../db/repositories/runner-jobs-repository.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { CleanupResult } from "../maintenance/cleanup.ts";
import { DEFAULT_SEND_LIMIT, type DispatchService } from "./service.ts";

/** How long a stopped dispatch rests before the Dispatcher is asked about it again. */
export const STOPPED_REVIVE_MS = 10 * 60 * 1000;

/** Where the hour of the last cleanup is kept, so that every instance sees the same one. */
export const CLEANUP_HOUR_KEY = "maintenance.sweep_cleanup_hour";
const HOUR_MS = 60 * 60 * 1000;

export const SWEEP_STEPS = [
  "expire",
  "give_up",
  "revive",
  "send",
  "notices",
  "cleanup",
] as const;
export type SweepStep = (typeof SWEEP_STEPS)[number];

export type SweepSettings = {
  /** Fail a job that waited this long for a claim; null: never. */
  giveUpMs: number | null;
  /** The pool cap: send no more than there are free slots below it; null: no cap on the app's side. */
  maxRunning: number | null;
};

export type SweepReport = {
  expired: ExpiryReport | null;
  givenUp: number;
  revived: number;
  sent: number;
  /** How many notices of refused reviews were tried again (#281). */
  noticesTried: number;
  cleanedUp: boolean;
  /** The steps that failed in this run. */
  failedSteps: SweepStep[];
};

export type SweepLog = Pick<Console, "info" | "error">;

export type SweepDependencies = {
  now?: () => Date;
  queue: Pick<
    RunnerQueue,
    "expireStaleJobs" | "failUndispatched" | "countRunning"
  >;
  dispatches: Pick<JobDispatchesRepository, "reviveStopped">;
  /** Absent in poll mode: nothing is sent and no row is revived. */
  dispatch?: Pick<DispatchService, "sendDue">;
  meta: Pick<AppMetaRepository, "get" | "set">;
  cleanup: () => Promise<CleanupResult>;
  /** #281: tries the notices of refused reviews that are due again. Left out, none is tried. */
  notices?: { retryDue(): Promise<{ tried: number }> };
  settings: SweepSettings;
  log?: SweepLog;
};

export type DispatchSweep = { run(): Promise<SweepReport> };

export function createDispatchSweep(deps: SweepDependencies): DispatchSweep {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;

  async function run(): Promise<SweepReport> {
    const report: SweepReport = {
      expired: null,
      givenUp: 0,
      revived: 0,
      sent: 0,
      noticesTried: 0,
      cleanedUp: false,
      failedSteps: [],
    };
    const step = async (name: SweepStep, work: () => Promise<void>) => {
      try {
        await work();
      } catch {
        report.failedSteps.push(name);
        log.error(`[sweep] SWEEP_STEP_FAILED step=${name}`);
      }
    };

    await step("expire", async () => {
      report.expired = await deps.queue.expireStaleJobs();
    });
    const { giveUpMs, maxRunning } = deps.settings;
    if (giveUpMs !== null)
      await step("give_up", async () => {
        report.givenUp = await deps.queue.failUndispatched(giveUpMs);
      });
    const dispatch = deps.dispatch;
    if (dispatch !== undefined) {
      await step("revive", async () => {
        const at = now();
        report.revived = await deps.dispatches.reviveStopped(
          new Date(at.getTime() - STOPPED_REVIVE_MS),
          at,
        );
      });
      await step("send", async () => {
        const free =
          maxRunning === null
            ? DEFAULT_SEND_LIMIT
            : Math.min(
                DEFAULT_SEND_LIMIT,
                maxRunning - (await deps.queue.countRunning()),
              );
        if (free > 0) report.sent = (await dispatch.sendDue(free)).sent;
      });
    }
    const notices = deps.notices;
    if (notices !== undefined)
      await step("notices", async () => {
        report.noticesTried = (await notices.retryDue()).tried;
      });
    await step("cleanup", async () => {
      const hour = Math.floor(now().getTime() / HOUR_MS);
      const done = Number(await deps.meta.get(CLEANUP_HOUR_KEY));
      if (Number.isInteger(done) && done >= hour) return;
      await deps.cleanup();
      await deps.meta.set(CLEANUP_HOUR_KEY, String(hour));
      report.cleanedUp = true;
    });

    const expired = report.expired;
    const changed =
      (expired !== null &&
        expired.requeued +
          expired.leaseExpired +
          expired.timedOut +
          expired.noCapableRunner >
          0) ||
      report.givenUp + report.revived + report.sent > 0;
    if (changed)
      log.info(
        `[sweep] requeued=${String(expired?.requeued ?? 0)} lease_expired=${String(expired?.leaseExpired ?? 0)} timed_out=${String(expired?.timedOut ?? 0)} given_up=${String(report.givenUp)} revived=${String(report.revived)} sent=${String(report.sent)}`,
      );
    return report;
  }

  return { run };
}
