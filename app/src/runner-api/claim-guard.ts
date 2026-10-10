// A hook between "a runner claimed a job" and "the runner gets its credentials": a place to refuse
// jobs that must not run any more. The runner API asks the guard before it creates any credentials.
// A refused job never reaches the runner, which is handed the next job instead.
//
// The rule it exists for (`createProjectClaimGuard`, project-claim-guard.ts): a job whose repository
// has no active project (the project was switched off after the job was queued) must not run.
// `allowAllClaimGuard` is for tests that are not about projects.
import type { Job } from "../jobs/job-types.ts";

export type ClaimGuardDecision =
  | { allow: true }
  | {
      allow: false;
      /**
       * Stored as the job's error code. Use a stable code, for example `project_deactivated` (one of
       * the codes of the queue, `JOB_ERROR_CODES`).
       */
      errorCode: string;
      /**
       * What happens to the refused job. `fail` (the default) ends it as `failed` with `errorCode`.
       * `cancel` gives the claim back and cancels every waiting job of the same repository, like a
       * deactivation does: the job ends as `cancelled` with `errorCode`, not as a failure.
       */
      outcome?: "fail" | "cancel";
    };

export type ClaimGuard = {
  /** Called once per claimed job, before credentials are created. A rejection answers 500. */
  check(job: Job): Promise<ClaimGuardDecision>;
};

/** The guard that lets every job run. */
export const allowAllClaimGuard: ClaimGuard = {
  check: async () => ({ allow: true }),
};
