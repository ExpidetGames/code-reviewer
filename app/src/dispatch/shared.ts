// SPDX-License-Identifier: LicenseRef-Proprietary

// The dispatch webhook of the running server: the hook the job queues of the request handlers get
// (src/jobs/shared.ts), and the service the sweep (#328) calls. Per request code asks for them here.
import "server-only";
import { after } from "next/server";
import type { EnqueueResult } from "../jobs/job-types.ts";
import { getDatabase } from "../db/startup.ts";
import { DispatchConfigError, loadDispatchConfig } from "./config.ts";
import { createDispatchHook } from "./hook.ts";
import { createDispatchService, type DispatchService } from "./service.ts";
import { createStopService, type StopService } from "./stop.ts";

/**
 * Runs `work` after the response was sent (Next's `after()`, which a serverless platform keeps the function
 * alive for). Outside a request there is no response to wait for, and the work simply starts. It never
 * rejects, so nothing here can fail the caller either way.
 */
export function runAfterResponse(work: () => Promise<void>): void {
  const safe = () => work().catch(() => undefined);
  try {
    after(safe);
  } catch {
    void safe();
  }
}

let invalidReported = false;

/** The hook for `createJobQueue`, or undefined while the instance polls (the default). */
export function dispatchHook(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ((result: EnqueueResult) => void) | undefined {
  return createDispatchHook({
    env,
    db: getDatabase(),
    schedule: runAfterResponse,
    reportInvalid: (line) => {
      // Once per process: every enqueue would say it again.
      if (invalidReported) return;
      invalidReported = true;
      console.error(line);
    },
  });
}

/**
 * The service for the sweep (#328): `sendDue()` sends every queued job that is due and not yet called, or
 * whose call is due again. Undefined in poll mode. Throws `DispatchConfigError` for a bad webhook setup.
 */
export function getDispatchService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DispatchService | undefined {
  const config = loadDispatchConfig(env);
  if (config.mode === "poll") return undefined;
  return createDispatchService({ db: getDatabase(), config });
}

/**
 * #487: the stop call to the Dispatcher, or undefined while the instance polls (a self-hosted runner and Compose
 * never get one). Throws `DispatchConfigError` for a bad webhook setup.
 */
export function getStopService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StopService | undefined {
  const config = loadDispatchConfig(env);
  if (config.mode === "poll") return undefined;
  return createStopService({ db: getDatabase(), config });
}

/**
 * #487: the claims of these jobs ended (a result, a failure, a cancel, a lapsed lease, a timeout): the Dispatcher is told
 * to stop their VMs, after the response, best effort. Never throws and never delays the call that ended the claims.
 */
export function stopEndedClaims(
  jobIds: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (jobIds.length === 0) return;
  try {
    const service = getStopService(env);
    if (service !== undefined) runAfterResponse(() => service.stopJobs(jobIds));
  } catch (error) {
    // A bad setting turns the stop off like the wake-up (the start check refuses it loudly); anything else is a code.
    if (!(error instanceof DispatchConfigError))
      console.error("[dispatch] DISPATCH_STOP_FAILED");
  }
}

export { DispatchConfigError };
