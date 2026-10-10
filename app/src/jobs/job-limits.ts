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

export type JobQueueLimits = {
  leaseMs: number;
  maxRuntimeMs: number;
  maxAttempts: number;
};

export const DEFAULT_JOB_QUEUE_LIMITS: JobQueueLimits = {
  leaseMs: DEFAULT_LEASE_MS,
  maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
};
