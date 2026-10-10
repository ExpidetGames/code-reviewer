// Where the webhook route hands a review trigger over. The route knows nothing about jobs: it
// translates a delivery into a `ReviewTrigger` and calls the intake. The jobs ticket (CR-27) and the
// automatic triggers ticket (CR-31) plug the real queue in by replacing `getReviewTriggerIntake` in
// `shared.ts`; the route does not change.
import type { Integration, ReviewTrigger } from "../integrations/types.ts";
import type { WebhookLogger } from "./logger.ts";

export type ReviewTriggerIntake = {
  /**
   * Takes over a trigger that came out of a verified delivery from an active integration, for which
   * `canTrigger` said yes. Contract:
   *
   * - It resolves once the trigger is recorded. If it rejects, the route answers with a `5xx` and
   *   forgets the delivery, so the redelivery of the same trigger arrives here again.
   * - It is called at most once per delivery id at a time, but the same trigger can come with
   *   another delivery id (a redelivery of the same event by hand, two identical comments). Deduping
   *   by pull request and head commit is the queue's business.
   * - It is quick: the route answers GitHub (which waits 10 seconds) after it returns.
   * - `trigger.args` and every other text in the trigger come from a pull request or a comment and
   *   are untrusted data.
   */
  enqueueReviewTrigger(
    trigger: ReviewTrigger,
    integration: Integration,
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
    async enqueueReviewTrigger(trigger, integration) {
      const command =
        trigger.command === null ? "" : ` command=${trigger.command}`;
      logger.info(
        `[webhook] review trigger kind=${trigger.kind}${command} repo=${trigger.repo.fullName} pr=${trigger.prNumber} head=${trigger.headSha.slice(0, 12)} integration=${integration.id}`,
      );
    },
  };
}
