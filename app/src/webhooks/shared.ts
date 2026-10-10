// The wiring of the webhook route: the real database, registry, sync service and intake. This is the
// one place that decides where review triggers go.
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getJobQueue } from "../jobs/shared.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getIntegrationSync } from "../integrations/sync/shared.ts";
import {
  createGithubAppWebhookHandler,
  type WebhookHandler,
} from "./github-app-handler.ts";
import { consoleWebhookLogger } from "./logger.ts";
import { createJobQueueReviewTriggerIntake } from "./job-queue-intake.ts";
import type { ReviewTriggerIntake } from "./review-trigger-intake.ts";

/**
 * Where review triggers go: into the job queue, as a thin mapping. The trigger policy (active
 * project, drafts, debounce) is added around this by the automatic triggers ticket (CR-31).
 */
export function getJobQueueReviewTriggerIntake(): ReviewTriggerIntake {
  return createJobQueueReviewTriggerIntake({
    queue: getJobQueue(),
    repositories: createRepositoriesRepository(getDatabase()),
    logger: consoleWebhookLogger,
  });
}

/** The handler of `POST /api/webhooks/github-app`, wired to the running server. */
export function getGithubAppWebhookHandler(): WebhookHandler {
  const db = getDatabase();
  return createGithubAppWebhookHandler({
    registry: integrationRegistry,
    integrations: createIntegrationsRepository(db),
    deliveries: createWebhookDeliveriesRepository(db),
    sync: getIntegrationSync(),
    intake: getJobQueueReviewTriggerIntake(),
    logger: consoleWebhookLogger,
  });
}
