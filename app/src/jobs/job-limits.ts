// SPDX-License-Identifier: Apache-2.0

// The time and attempt limits of the queue. Defaults follow the project decisions; the queue takes
// overrides so tests (and, later, the settings) can shorten them.

/** A runner holds a job for this long after its last heartbeat (runners beat every 30 seconds). */
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;

/**
 * A job that runs longer than this is failed with `timeout`, whatever its heartbeats say: the
 * runner's hard timeout (20 minutes by default) plus 5 minutes of grace.
 */
export const DEFAULT_MAX_RUNTIME_MS = 25 * 60 * 1000;

/** How many times a job may be started in all; the last lost lease fails the job. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * #195: how long a Dynamic job may wait for a runner that can run it. Until #202 ships the engine no
 * production runner advertises `opencode`, so a Dynamic job would otherwise wait forever. After this
 * deadline it is cancelled with `no_capable_runner` — never failed for a review reason, and no attempt
 * is counted. The operator owns the value (`RUNNER_NO_CAPABLE_TIMEOUT_SECONDS`).
 */
export const DEFAULT_NO_CAPABLE_RUNNER_MS = 30 * 60 * 1000;

export type JobQueueLimits = {
  leaseMs: number;
  maxRuntimeMs: number;
  maxAttempts: number;
  noCapableRunnerMs: number;
};

export const DEFAULT_JOB_QUEUE_LIMITS: JobQueueLimits = {
  leaseMs: DEFAULT_LEASE_MS,
  maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  noCapableRunnerMs: DEFAULT_NO_CAPABLE_RUNNER_MS,
};

/** The environment variable an operator sets to own the deadline; seconds. */
export const NO_CAPABLE_RUNNER_VARIABLE = "RUNNER_NO_CAPABLE_TIMEOUT_SECONDS";

/**
 * The operator's deadline for a job no capable runner claims (#195). A missing, non-numeric or
 * non-positive value keeps the default, so a typo never disables the bound.
 */
export function configuredNoCapableRunnerMs(
  environment: Record<string, string | undefined>,
): number {
  const raw = environment[NO_CAPABLE_RUNNER_VARIABLE]?.trim();
  if (!raw) return DEFAULT_NO_CAPABLE_RUNNER_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    return DEFAULT_NO_CAPABLE_RUNNER_MS;
  return Math.round(seconds * 1000);
}
