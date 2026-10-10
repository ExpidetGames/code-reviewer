// The wiring of the webhook route: the real database, registry, sync service and intake. This is the
// one place that decides where review triggers go; the jobs tickets replace
// `getReviewTriggerIntake` and nothing else changes.
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getIntegrationSync } from "../integrations/sync/shared.ts";
import {
  createGithubAppWebhookHandler,
  type WebhookHandler,
} from "./github-app-handler.ts";
import { consoleWebhookLogger } from "./logger.ts";
import {
  createLoggingReviewTriggerIntake,
  type ReviewTriggerIntake,
} from "./review-trigger-intake.ts";

/**
 * Where review triggers go. Until the jobs table exists (CR-27) and the automatic triggers are
 * built (CR-31), a trigger is only logged.
 */
export function getReviewTriggerIntake(): ReviewTriggerIntake {
  return createLoggingReviewTriggerIntake(consoleWebhookLogger);
}

/** The handler of `POST /api/webhooks/github-app`, wired to the running server. */
export function getGithubAppWebhookHandler(): WebhookHandler {
  const db = getDatabase();
  return createGithubAppWebhookHandler({
    registry: integrationRegistry,
    integrations: createIntegrationsRepository(db),
    deliveries: createWebhookDeliveriesRepository(db),
    sync: getIntegrationSync(),
    intake: getReviewTriggerIntake(),
    logger: consoleWebhookLogger,
  });
}
