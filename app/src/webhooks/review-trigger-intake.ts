// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the webhook route hands a review trigger over. The route knows nothing about jobs: it
// translates a delivery into a `ReviewTrigger` and calls the intake. The intake of the running app
// is `createJobQueueReviewTriggerIntake` (job-queue-intake.ts), wired in `shared.ts`. The trigger
// policy (drafts, settings, stale commits) is decided before the intake, by the handler
// with `automatic-review-policy.ts`.
import type {
  Integration,
  RepoRef,
  ReviewTrigger,
} from "../integrations/types.ts";

/** The delivery a trigger came from, for tracing a job back to it and for idempotent enqueueing. */
export type ReviewTriggerSource = {
  /** `X-GitHub-Delivery`; the same id again for a redelivery. */
  deliveryId: string;
  /** `X-GitHub-Event`, for example "pull_request". */
  event: string;
};

export type ReviewTriggerIntake = {
  /**
   * Takes over a trigger that came out of a verified delivery from an active integration, for a
   * repository with an active project, for which `canTrigger` said yes. Contract:
   *
   * - It resolves once the trigger is recorded. If it rejects, the route answers with a `5xx` and
   *   releases the delivery, so the redelivery (GitHub's "Redeliver" keeps the delivery id) arrives
   *   here again.
   * - The route's claim of the delivery id and the intake's write are not one transaction, so the
   *   same delivery can arrive twice (the route's record of the outcome failed, a claim ran out
   *   while the first request was still working). Make the enqueue idempotent per
   *   `source.deliveryId`.
   * - **The queue must also deduplicate on (pull request, head commit, command)**, not on the
   *   delivery id alone. The delivery id is not covered by GitHub's signature, so a captured signed
   *   body replayed with a new id passes the route; and the same event can legitimately come twice
   *   under different ids (two identical comments). Replay protection is that dedupe.
   * - A trigger that can never be accepted (invalid for every retry) is dropped and logged rather
   *   than rejected: a rejection makes every redelivery fail the same way.
   * - It is quick: the route answers GitHub (which waits 10 seconds) after it returns.
   * - `trigger.args` and every other text in the trigger come from a pull request or a comment and
   *   are untrusted data.
   */
  enqueueReviewTrigger(
    trigger: ReviewTrigger,
    integration: Integration,
    source: ReviewTriggerSource,
  ): Promise<void>;

  /**
   * A pull request was closed or merged: drops every job that still waits for it, the automatic
   * ones and the ones a person started with a comment or the start button (a closed pull request
   * takes no commands). A job that already runs is left to finish. Resolves with the number of
   * dropped jobs, which is zero when nothing waited, and when the repository is unknown. Idempotent.
   */
  discardWaitingJobs(
    repo: RepoRef,
    integration: Integration,
    prNumber: number,
  ): Promise<number>;

  /**
   * A pull request was turned into a draft: drops the waiting automatic jobs only. A job a person
   * started stays, because a draft can be reviewed on request. Same result as `discardWaitingJobs`.
   */
  discardWaitingAutomaticJobs(
    repo: RepoRef,
    integration: Integration,
    prNumber: number,
  ): Promise<number>;
};
