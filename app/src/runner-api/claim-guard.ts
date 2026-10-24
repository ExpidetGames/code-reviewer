// SPDX-License-Identifier: LicenseRef-Proprietary

// A hook between "a runner claimed a job" and "the runner gets its credentials": a place to refuse
// jobs that must not run any more. The runner API asks the guard before it creates any credentials.
// A refused job never reaches the runner, which is handed the next job instead.
//
// The rule it exists for (`createProjectClaimGuard`, project-claim-guard.ts): a job whose repository
// has no active project (the project was switched off after the job was queued) must not run.
// `allowAllClaimGuard` is for tests that are not about projects.
import type { Job, JobErrorCode } from "../jobs/job-types.ts";

export type ClaimGuardDecision =
  | { allow: true }
  /** Ends the job as `failed` with `errorCode`, which is stored as the job's error code. */
  | { allow: false; errorCode: string; outcome?: "fail" }
  /**
   * Ends the job as `cancelled` with `errorCode` (one of the queue's codes, `JOB_ERROR_CODES`, for
   * example `project_deactivated`), like a deactivation ends a waiting job: the job did nothing wrong.
   * One statement fenced by the lease token (`cancelClaimed`), no attempt is counted.
   */
  | { allow: false; errorCode: JobErrorCode; outcome: "cancel" };

export type ClaimGuard = {
  /** Called once per claimed job, before credentials are created. A rejection answers 500. */
  check(job: Job): Promise<ClaimGuardDecision>;
};

/** The guard that lets every job run. */
export const allowAllClaimGuard: ClaimGuard = {
  check: async () => ({ allow: true }),
};
