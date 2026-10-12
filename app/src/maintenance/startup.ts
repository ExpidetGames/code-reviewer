// SPDX-License-Identifier: Apache-2.0

// What the production server does about old rows: clean up when it starts and then every hour
// (cleanup.ts). Called from `src/instrumentation.ts`. Other environments (the dev server, tests) run no
// timer. A failing run is logged by its code and tried again at the next hour; it never stops the app.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { cleanUpExpiredRows, type CleanupResult } from "./cleanup.ts";

export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export type CleanupTimer = { stop: () => void };

type StartOptions = {
  run?: () => Promise<CleanupResult>;
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

/** Runs the cleanup now and again at every interval. */
export function startCleanup({
  run = () => cleanUpExpiredRows(getDatabase()),
  setTimer = defaultSetTimer,
  log = console,
}: StartOptions = {}): CleanupTimer {
  const once = async (): Promise<void> => {
    try {
      const removed = await run();
      if (
        removed.rateLimits +
          removed.verificationTokens +
          removed.passwordResetTokens >
        0
      )
        log.info(
          `[maintenance] removed ${String(removed.rateLimits)} old rate limit counters, ${String(removed.verificationTokens)} old verification links and ${String(removed.passwordResetTokens)} old reset links.`,
        );
    } catch {
      log.error(
        "[maintenance] CLEANUP_FAILED: old rows could not be removed; trying again at the next hour.",
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
