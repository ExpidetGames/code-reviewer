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
import { getProjectService } from "../projects/shared.ts";
import { getReviewSettingsService } from "../review-settings/shared.ts";
import { configuredDebounceMs } from "./debounce-config.ts";
import { consoleWebhookLogger } from "./logger.ts";
import { createJobQueueReviewTriggerIntake } from "./job-queue-intake.ts";
import type { ReviewTriggerIntake } from "./review-trigger-intake.ts";

/**
 * Where review triggers go: into the job queue, as a thin mapping. The trigger policy (active
 * project, drafts, settings, debounce) is applied by the handler before it calls the intake.
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
    projects: getProjectService(),
    automatic: {
      // The settings of the repository's project: project over global over built-in.
      async settingsFor(integrationId, repositoryExternalId) {
        const repository = await createRepositoriesRepository(
          db,
        ).findByExternalId(integrationId, repositoryExternalId);
        if (repository === undefined) return undefined;
        return (
          await getReviewSettingsService().resolveForRepository(repository.id)
        )?.settings;
      },
      debounceMs: configuredDebounceMs(process.env),
      now: () => new Date(),
    },
    intake: getJobQueueReviewTriggerIntake(),
    logger: consoleWebhookLogger,
  });
}
