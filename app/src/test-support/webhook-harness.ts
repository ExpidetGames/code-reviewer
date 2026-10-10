// Everything a test of the webhook route needs: the sync harness (a real SQLite file, the fake
// GitHub API, the real GitHub App provider behind a registry), the delivery record, a recording
// intake and the route's handler wired to all of them. `deliver*` builds signed requests like GitHub.
import { vi } from "vitest";
import {
  signWebhookBody,
  webhookDelivery,
  webhookFixture,
  type WebhookDeliveryOptions,
} from "../../../fakes/github/webhooks.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import { createIntegrationRegistry } from "../integrations/registry.ts";
import { createGithubAppWebhookHandler } from "../webhooks/github-app-handler.ts";
import type { WebhookLogger } from "../webhooks/logger.ts";
import { TEST_WEBHOOK_SECRET } from "./github-app.ts";
import { startSyncHarness } from "./integration-sync-harness.ts";
import { createRecordingReviewTriggerIntake } from "./recording-review-trigger-intake.ts";

export async function startWebhookHarness(
  options: {
    maxBodyBytes?: number;
    env?: Record<string, string | undefined>;
    /** Changes the real provider, for example to make `canTrigger` refuse. */
    wrapProvider?: (provider: IntegrationProvider) => IntegrationProvider;
  } = {},
) {
  const base = await startSyncHarness(
    options.env === undefined ? {} : { env: options.env },
  );
  const github = base.registry.resolve("github_app");
  const provider = options.wrapProvider?.(github) ?? github;
  // Spies on the calls that matter for the order of the route's steps.
  const verifyWebhook = vi.spyOn(provider, "verifyWebhook");
  const parseEvent = vi.spyOn(provider, "parseEvent");
  const registry = createIntegrationRegistry({ github_app: provider });

  const deliveries = createWebhookDeliveriesRepository(base.db);
  const intake = createRecordingReviewTriggerIntake();
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  const logger: WebhookLogger = {
    info: (line) => infoLines.push(line),
    error: (line) => errorLines.push(line),
  };
  const handler = createGithubAppWebhookHandler({
    registry,
    integrations: base.integrations,
    deliveries,
    sync: base.sync,
    intake,
    logger,
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes }),
  });

  /** The installation 4242 of "acme" with one repository, stored as an active integration. */
  async function seedInstallation() {
    base.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    base.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await base.sync.syncAll();
    const integration = await base.integrations.findByExternalId(
      "github_app",
      "4242",
    );
    if (integration === undefined) throw new Error("seeding failed");
    return integration;
  }

  /** A signed delivery of a recorded payload, for example `deliver("pull_request.opened")`. */
  function deliver(
    fixture: string,
    overrides: Partial<WebhookDeliveryOptions> = {},
  ): Promise<Response> {
    return handler(
      webhookDelivery({
        event: fixture.split(".")[0] as string,
        payload: webhookFixture(fixture),
        secret: TEST_WEBHOOK_SECRET,
        ...overrides,
      }),
    );
  }

  /**
   * A delivery with a body and headers chosen by the test, signed with the right secret unless
   * `signature` says otherwise. A header set to `null` is left out.
   */
  function deliverRaw(
    body: string,
    headers: Record<string, string | null> = {},
    signature?: string | null,
  ): Promise<Response> {
    const all: Record<string, string | null> = {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256":
        signature === undefined
          ? signWebhookBody(body, TEST_WEBHOOK_SECRET)
          : signature,
      ...headers,
    };
    const requestHeaders = new Headers();
    for (const [name, value] of Object.entries(all))
      if (value !== null) requestHeaders.set(name, value);
    return handler(
      new Request("https://app.test/api/webhooks/github-app", {
        method: "POST",
        headers: requestHeaders,
        body,
      }),
    );
  }

  /** Every table the route may touch, for "nothing changed" assertions. */
  async function snapshotTables() {
    return {
      integrations: await base.db
        .selectFrom("integrations")
        .selectAll()
        .execute(),
      repositories: await base.db
        .selectFrom("repositories")
        .selectAll()
        .execute(),
      deliveries: await base.db
        .selectFrom("webhook_deliveries")
        .selectAll()
        .execute(),
    };
  }

  return {
    ...base,
    provider,
    verifyWebhook,
    parseEvent,
    deliveries,
    intake,
    handler,
    infoLines,
    errorLines,
    seedInstallation,
    deliver,
    deliverRaw,
    snapshotTables,
    /** Every line the route logged. */
    logLines: () => [...infoLines, ...errorLines],
  };
}

export type WebhookHarness = Awaited<ReturnType<typeof startWebhookHarness>>;
