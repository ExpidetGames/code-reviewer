// SPDX-License-Identifier: Apache-2.0

// What a long-lived server (Docker Compose, Coolify, a process) does about the check runs of its jobs (#405): look
// for the jobs whose GitHub state is behind now and then every minute (a lease that ran out, a timeout, a give-up, a
// switched-off project and a failed sync that waits for its retry end or change a job without a request of their own).
// Called from `src/instrumentation.ts`. A hosted deployment has no timer: the sweep and the requests that touch the
// database do this (src/dispatch/README.md). Other environments (the dev server, tests) run no timer. A failing run
// is logged by its code and tried again at the next tick; it never stops the app, and one run never overlaps another.
import "server-only";
import type { CheckRunService } from "./service.ts";
import { getCheckRunService } from "./shared.ts";

export const CHECK_RECONCILE_INTERVAL_MS = 60 * 1000;

export type CheckReconcilerTimer = { stop: () => void };

type StartOptions = {
  service?: Pick<CheckRunService, "reconcileDue">;
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

/** Reconciles now and again at every interval. */
export function startCheckReconciler({
  service,
  setTimer = defaultSetTimer,
  log = console,
}: StartOptions = {}): CheckReconcilerTimer {
  let running = false;
  const once = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const { synced } = await (service ?? getCheckRunService()).reconcileDue();
      if (synced > 0)
        log.info(
          `[check-runs] synced the check runs of ${String(synced)} jobs.`,
        );
    } catch {
      // Nothing a database or GitHub said is logged: a connection string can be in it.
      log.error(
        "[check-runs] CHECK_RUN_RECONCILE_FAILED: the check runs could not be reconciled; trying again.",
      );
    } finally {
      running = false;
    }
  };
  void once();
  return { stop: setTimer(() => void once(), CHECK_RECONCILE_INTERVAL_MS) };
}

export function startCheckReconcilerOnStart({
  env = process.env,
  ...options
}: StartOptions & {
  env?: Readonly<Record<string, string | undefined>>;
} = {}): CheckReconcilerTimer | null {
  if (env.NODE_ENV !== "production") return null;
  return startCheckReconciler(options);
}
