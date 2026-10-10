// Where the webhook route hands a review trigger over. The route knows nothing about jobs: it
// translates a delivery into a `ReviewTrigger` and calls the intake. The jobs ticket (CR-27) and the
// automatic triggers ticket (CR-31) plug the real queue in by replacing `getReviewTriggerIntake` in
// `shared.ts`; the route does not change.
import type { Integration, ReviewTrigger } from "../integrations/types.ts";
import type { WebhookLogger } from "./logger.ts";

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
   * - **The queue (CR-27) must also deduplicate on (pull request, head commit, command)**, not on the
   *   delivery id alone. The delivery id is not covered by GitHub's signature, so a captured signed
   *   body replayed with a new id passes the route; and the same event can legitimately come twice
   *   under different ids (two identical comments). Replay protection is that dedupe.
   * - It is quick: the route answers GitHub (which waits 10 seconds) after it returns.
   * - `trigger.args` and every other text in the trigger come from a pull request or a comment and
   *   are untrusted data.
   */
  enqueueReviewTrigger(
    trigger: ReviewTrigger,
    integration: Integration,
    source: ReviewTriggerSource,
  ): Promise<void>;
};

/**
 * The intake of the app until the jobs table exists: it only logs the trigger (never `args`, which
 * is free text from a comment).
 */
export function createLoggingReviewTriggerIntake(
  logger: WebhookLogger,
): ReviewTriggerIntake {
  return {
    async enqueueReviewTrigger(trigger, integration, source) {
      const command =
        trigger.command === null ? "" : ` command=${trigger.command}`;
      logger.info(
        `[webhook] review trigger kind=${trigger.kind}${command} repo=${trigger.repo.fullName} pr=${trigger.prNumber} head=${trigger.headSha.slice(0, 12)} integration=${integration.id} delivery=${source.deliveryId}`,
      );
    },
  };
}
