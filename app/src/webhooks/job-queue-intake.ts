// SPDX-License-Identifier: Apache-2.0

// The review trigger intake of the running app: it turns a trigger into a job in the queue. This is
// a thin mapping and nothing else. Deciding whether a trigger deserves a job (the repository has an
// active project, drafts wait, `synchronize` is debounced) is trigger policy, which the webhook
// handler applies before it calls the intake (automatic-review-policy.ts), not inside the queue.
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type {
  Integration,
  RepoRef,
  ReviewTrigger,
} from "../integrations/types.ts";
import { JobQueueError } from "../jobs/errors.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { EnqueueJobInput } from "../jobs/job-types.ts";
import type { WebhookLogger } from "./logger.ts";
import type {
  EnqueueOptions,
  ReviewTriggerIntake,
  ReviewTriggerSource,
} from "./review-trigger-intake.ts";

export type JobQueueIntakeDeps = {
  queue: Pick<
    JobQueue,
    "enqueue" | "discardWaitingForPr" | "discardWaitingAutomaticForPr"
  >;
  repositories: Pick<RepositoriesRepository, "findByExternalId">;
  logger: WebhookLogger;
};

/**
 * How a trigger becomes a job. A pull request that was opened or updated is an automatic `webhook`
 * job for the default command; a command written in a comment is a `comment` job with its arguments.
 */
export function jobInputForTrigger(
  trigger: ReviewTrigger,
  repositoryId: string,
  source: ReviewTriggerSource,
  options: EnqueueOptions = {},
): EnqueueJobInput {
  const common = {
    repositoryId,
    prNumber: trigger.prNumber,
    prUrl: trigger.prUrl,
    headSha: trigger.headSha,
    actorLogin: trigger.actor.login,
    deliveryId: source.deliveryId,
    ...(options.runAfter === undefined ? {} : { runAfter: options.runAfter }),
  };
  if (trigger.kind === "command")
    return {
      ...common,
      command: trigger.command,
      args: trigger.args,
      commentId: trigger.commentId,
      triggerKind: "comment",
    };
  return { ...common, command: "review", triggerKind: "webhook" };
}

/** The intake that puts review triggers into the job queue. */
export function createJobQueueReviewTriggerIntake(
  deps: JobQueueIntakeDeps,
): ReviewTriggerIntake {
  async function discard(
    repo: RepoRef,
    integration: Integration,
    prNumber: number,
    scope: "all" | "automatic",
  ): Promise<number> {
    const repository = await deps.repositories.findByExternalId(
      integration.id,
      repo.externalId,
    );
    // No row, no jobs: nothing can wait for a repository the app has never heard of.
    if (repository === undefined) return 0;
    const discarded =
      scope === "all"
        ? await deps.queue.discardWaitingForPr(repository.id, prNumber)
        : await deps.queue.discardWaitingAutomaticForPr(
            repository.id,
            prNumber,
          );
    deps.logger.info(
      `[webhook] waiting jobs discarded scope=${scope} count=${discarded} repo=${repo.fullName} pr=${prNumber}`,
    );
    return discarded;
  }

  return {
    async enqueueReviewTrigger(
      trigger,
      integration: Integration,
      source,
      options,
    ) {
      const repository = await deps.repositories.findByExternalId(
        integration.id,
        trigger.repo.externalId,
      );
      // The repository list is synchronized from the platform; a delivery can outrun it. Rejecting
      // makes the route release the delivery, so GitHub's "Redeliver" works once the sync is done.
      if (repository === undefined)
        throw new JobQueueError(
          "JOB_REPOSITORY_UNKNOWN",
          `No repository row for ${trigger.repo.fullName} in integration ${integration.id}.`,
        );

      let result;
      try {
        result = await deps.queue.enqueue(
          jobInputForTrigger(trigger, repository.id, source, options),
        );
      } catch (error) {
        // Input the queue refuses will be refused every time: rejecting would make the route answer
        // 500 and release the delivery, and every redelivery would fail the same way. The trigger is
        // dropped with a log line (field names and codes only, never values). The one case that can
        // happen is arguments over `JOB_ARGS_MAX_LENGTH`; the provider cuts a comment's question
        // far below that, so this is a safety net.
        if (
          error instanceof JobQueueError &&
          error.code === "JOB_INPUT_INVALID"
        ) {
          deps.logger.error(
            `[webhook] trigger dropped, the job is not valid fields=${error.fieldErrors.map((field) => `${field.field}:${field.code}`).join(",")} repo=${trigger.repo.fullName} pr=${trigger.prNumber} delivery=${source.deliveryId}`,
          );
          return;
        }
        throw error;
      }
      const why =
        result.status === "existing" ? ` reason=${result.reason}` : "";
      deps.logger.info(
        `[webhook] job ${result.status} job=${result.job.id}${why} repo=${trigger.repo.fullName} pr=${trigger.prNumber} command=${result.job.command} delivery=${source.deliveryId}`,
      );
    },
    async discardWaitingJobs(repo, integration, prNumber) {
      return discard(repo, integration, prNumber, "all");
    },
    async discardWaitingAutomaticJobs(repo, integration, prNumber) {
      return discard(repo, integration, prNumber, "automatic");
    },
  };
}
