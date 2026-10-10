// A hook between "a runner claimed a job" and "the runner gets its credentials": a place to refuse
// jobs that must not run any more. The runner API asks the guard before it creates any credentials,
// and a refused job ends as failed with the guard's code (the runner never hears of it and is
// handed the next job instead).
//
// The MVP rule it exists for: a job whose repository has no active project (the project was
// switched off after the job was queued) must not run. Projects live on another epic branch (CR-5),
// so this branch only has the default guard, which allows everything. When the epics meet, the
// wiring in shared.ts replaces it with a guard that asks the projects (see README.md).
import type { Job } from "../jobs/job-types.ts";

export type ClaimGuardDecision =
  | { allow: true }
  /**
   * `errorCode` is stored as the job's error code. Use a stable code, for example
   * `project_deactivated` (one of the codes of the queue, `JOB_ERROR_CODES`).
   */
  | { allow: false; errorCode: string };

export type ClaimGuard = {
  /** Called once per claimed job, before credentials are created. A rejection answers 500. */
  check(job: Job): Promise<ClaimGuardDecision>;
};

/** The guard of this branch: every job may run. */
export const allowAllClaimGuard: ClaimGuard = {
  check: async () => ({ allow: true }),
};
