// The handler behind `POST /api/webhooks/github-app`. It is a function of its collaborators, so the
// route file only wires the real ones in (`shared.ts`) and tests wire fakes in.
//
// The order is the contract; each step ends the request on failure, and nothing before the claim of
// the delivery id has a side effect:
//
//   1. size      the body is read with a 1 MB limit                               413
//   2. signature `verifyWebhook(null, request)`: HMAC of the exact body            401
//   3. shape     the event and delivery headers exist, the body is JSON            400
//   4. relevance an event the app does not use is answered at once                 202
//   5. claim     the delivery id is recorded; a known id is a duplicate            202
//   6. identify  `identifyWebhook` names the installation; the integration is loaded
//   7. translate `parseEvent`: a review trigger, an installation change or "ignored"
//   8. act       trigger -> `canTrigger`, then the intake; change -> the shared sync  202
//
// A failure after the claim releases it (nothing is remembered) and answers with a 5xx, so GitHub's
// redelivery is handled again. The answer is sent when the work is done: the work is small (a few
// GitHub calls at most, each with a 15 second timeout), and a failure has to reach GitHub as a status
// code, which `after()` could not do.
import "server-only";
import type { WebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { hasSafeMessage } from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { IntegrationSyncService } from "../integrations/sync/service.ts";
import type {
  Integration,
  IntegrationEvent,
  IntegrationType,
} from "../integrations/types.ts";
import {
  WebhookProcessingError,
  type WebhookAcceptedOutcome,
  type WebhookErrorCode,
} from "./errors.ts";
import { readLimitedBody } from "./limited-body.ts";
import { consoleWebhookLogger, type WebhookLogger } from "./logger.ts";
import type { ReviewTriggerIntake } from "./review-trigger-intake.ts";

/** 1 MiB. GitHub's own limit is 25 MB, but the payloads this app reads are a few kilobytes. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const TYPE: IntegrationType = "github_app";

/** The events that can start a review or change what the app knows about the installation. */
const REVIEW_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "issue_comment",
]);
const INSTALLATION_EVENTS: ReadonlySet<string> = new Set([
  "installation",
  "installation_repositories",
]);

// Letters, digits, `_`, `-`, `.`; GitHub's delivery id is a UUID, its event names are snake case.
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type GithubAppWebhookDeps = {
  registry: IntegrationRegistry;
  integrations: Pick<IntegrationsRepository, "findByExternalId">;
  deliveries: WebhookDeliveriesRepository;
  /** The process-wide sync service (`getIntegrationSync()`), never one created for the route. */
  sync: Pick<IntegrationSyncService, "handleInstallationChange">;
  intake: ReviewTriggerIntake;
  logger?: WebhookLogger;
  maxBodyBytes?: number;
};

export type WebhookHandler = (request: Request) => Promise<Response>;

function fail(status: number, error: WebhookErrorCode): Response {
  return Response.json({ error }, { status });
}

function accepted(outcome: WebhookAcceptedOutcome): Response {
  return Response.json({ status: "accepted", outcome }, { status: 202 });
}

/** Lines about an error never carry more than its safe message. */
function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown error";
  return hasSafeMessage(error) ? `${name}: ${error.message}` : name;
}

// A delivery about an installation that has no row yet. The provider needs an integration to
// translate it; the sync creates the real row after GitHub confirmed the installation.
function standIn(externalId: string): Integration {
  return {
    id: "unknown",
    type: TYPE,
    displayName: "",
    externalId,
    config: {},
    credentials: null,
    webhookSecret: null,
    status: "active",
    createdAt: "",
    updatedAt: "",
  };
}

export function createGithubAppWebhookHandler(
  deps: GithubAppWebhookDeps,
): WebhookHandler {
  const { registry, integrations, deliveries, sync, intake } = deps;
  const logger = deps.logger ?? consoleWebhookLogger;
  const maxBodyBytes = deps.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;

  type Outcome = Exclude<
    WebhookAcceptedOutcome,
    "event_not_used" | "duplicate"
  >;

  /** Steps 6 to 8: everything after the delivery was claimed. */
  async function handleDelivery(
    eventName: string,
    request: Request,
  ): Promise<Outcome> {
    const provider = registry.resolve(TYPE);

    const identity = await provider.identifyWebhook(request);
    if (identity === null) return "ignored";

    const integration = await integrations.findByExternalId(
      TYPE,
      identity.externalId,
    );
    const isInstallationEvent = INSTALLATION_EVENTS.has(eventName);

    // A suspended or removed installation reviews nothing; its own events still go through (they are
    // how it comes back).
    if (integration?.status === "disabled" && !isInstallationEvent)
      return "integration_disabled";
    // Only an installation event can introduce an installation we do not know yet.
    if (integration === undefined && !isInstallationEvent)
      return "unknown_installation";

    const event: IntegrationEvent = await provider.parseEvent(
      integration ?? standIn(identity.externalId),
      request,
    );

    if (event.kind === "ignored") {
      logger.info(`[webhook] ignored: ${event.reason}`);
      return "ignored";
    }

    if (event.kind === "installation_changed") {
      const result = await sync.handleInstallationChange({
        type: TYPE,
        externalId: event.externalId,
        action: event.action,
      });
      if (result.outcome === "failed")
        throw new WebhookProcessingError(
          `the installation could not be synchronized (${result.summary.errors.map((error) => error.code).join(", ")})`,
          503,
        );
      return "installation_changed";
    }

    // A review trigger. Only an installation event reaches here without a row, and it never yields a
    // trigger; the check keeps that true even if a provider changes.
    if (integration === undefined) return "unknown_installation";
    if (!(await provider.canTrigger(integration, event.trigger)))
      return "trigger_not_allowed";
    await intake.enqueueReviewTrigger(event.trigger, integration);
    return "trigger_enqueued";
  }

  return async function handle(request) {
    // 1. size
    const body = await readLimitedBody(request, maxBodyBytes);
    if (!body.ok) return fail(413, "WEBHOOK_BODY_TOO_LARGE");

    // The provider reads the exact body again, so it gets a request of its own with the text we read.
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const verified = new Request(request.url, {
      method: "POST",
      headers,
      body: body.text,
    });

    // 2. signature
    const provider = registry.resolve(TYPE);
    let genuine: boolean;
    try {
      genuine = await provider.verifyWebhook(null, verified);
    } catch (error) {
      logger.error(
        `[webhook] deliveries cannot be verified: ${describeError(error)}`,
      );
      return fail(503, "WEBHOOK_NOT_CONFIGURED");
    }
    if (!genuine) {
      logger.info("[webhook] refused a delivery with an invalid signature");
      return fail(401, "WEBHOOK_SIGNATURE_INVALID");
    }

    // 3. shape
    const eventName = request.headers.get("x-github-event");
    if (eventName === null || !EVENT_NAME.test(eventName))
      return fail(400, "WEBHOOK_EVENT_HEADER_INVALID");
    const deliveryId = request.headers.get("x-github-delivery");
    if (deliveryId === null || !DELIVERY_ID.test(deliveryId))
      return fail(400, "WEBHOOK_DELIVERY_HEADER_INVALID");
    try {
      JSON.parse(body.text);
    } catch {
      return fail(400, "WEBHOOK_BODY_NOT_JSON");
    }

    // 4. relevance
    if (!REVIEW_EVENTS.has(eventName) && !INSTALLATION_EVENTS.has(eventName))
      return accepted("event_not_used");

    // 5. claim
    const label = `delivery=${deliveryId} event=${eventName}`;
    try {
      if ((await deliveries.claim(deliveryId, eventName)) === "duplicate") {
        logger.info(`[webhook] ${label} outcome=duplicate`);
        return accepted("duplicate");
      }
    } catch (error) {
      logger.error(
        `[webhook] ${label} cannot be recorded: ${describeError(error)}`,
      );
      return fail(500, "WEBHOOK_PROCESSING_FAILED");
    }

    // 6. to 8.
    let outcome: Outcome;
    try {
      outcome = await handleDelivery(eventName, verified);
    } catch (error) {
      logger.error(`[webhook] ${label} failed: ${describeError(error)}`);
      // Forget the delivery so the redelivery is handled. If this fails too, the claim runs out by
      // itself (WEBHOOK_DELIVERY_PROCESSING_LEASE_MS).
      await deliveries
        .release(deliveryId)
        .catch((releaseError: unknown) =>
          logger.error(
            `[webhook] ${label} cannot be released: ${describeError(releaseError)}`,
          ),
        );
      return fail(
        error instanceof WebhookProcessingError ? error.status : 500,
        "WEBHOOK_PROCESSING_FAILED",
      );
    }

    await deliveries
      .complete(deliveryId, outcome)
      .catch((error: unknown) =>
        logger.error(
          `[webhook] ${label} outcome cannot be recorded: ${describeError(error)}`,
        ),
      );
    logger.info(`[webhook] ${label} outcome=${outcome}`);
    return accepted(outcome);
  };
}
