// The life of a job as a table: which status may follow which. The repository builds its update
// conditions from this table (`statusesThatCanBecome`), so the rules here and the rules in SQL
// cannot drift apart. Statuses are stored in the database, so a value is never renamed or reused.

/**
 * - `queued`      waiting for a runner (or waiting for its `run_after`)
 * - `running`     held by a runner under a lease
 * - `succeeded`   finished, the review was published
 * - `failed`      finished without a result; `error_code` says why
 * - `superseded`  replaced by a newer job for the same pull request while it was still waiting
 * - `cancelled`   dropped while waiting (project deactivated, pull request closed)
 */
export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  // `failed` straight from `queued`: a job that cannot be started (for example no LLM key
  // configured) is failed when it is claimed, and a claim that goes wrong is undone by `running`
  // to `queued`.
  queued: ["running", "superseded", "cancelled", "failed"],
  // `queued` again only when the lease ran out or the claim was given back.
  running: ["succeeded", "failed", "queued"],
  succeeded: [],
  failed: [],
  superseded: [],
  cancelled: [],
};

export function isJobStatus(value: unknown): value is JobStatus {
  return JOB_STATUSES.some((status) => status === value);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The statuses from which a job may become `to`. */
export function statusesThatCanBecome(to: JobStatus): JobStatus[] {
  return JOB_STATUSES.filter((from) => canTransition(from, to));
}

/** A job in one of these never changes again. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
