// SPDX-License-Identifier: Apache-2.0

// `POST /api/billing/webhook` (#441, ADR 0005, 2.12): the Paddle notification destination of the app. The body is data until its
// signature is verified, so the order is fixed:
//
//   1. the secret of the destination and the configured environment (an unreadable secret is 503: nothing could be verified);
//   2. the raw body, read once with a hard size limit (413);
//   3. `Paddle-Signature` against exactly those bytes, in constant time, with a tolerance (401, empty body, a code in the log);
//   4. only now is the body parsed (400 when a signed body is no Paddle event);
//   5. ONE database transaction: the event id is claimed (`insert ... on conflict do nothing`: a duplicate answers 200 and stops),
//      the event is applied, its outcome is recorded; commit; 200. Any exception answers 500 and nothing is half applied, so
//      Paddle's retry applies the event whole.
//
// No outbound call is made (Paddle wants its answer within 5 seconds and a cold start counts). Nothing about the body is logged or
// stored beyond ids, a type, a stamp and an outcome code. A refusal has an empty body and tells the caller nothing.
//
// The tolerance of the signature is a parameter, not a constant: whether Paddle signs each retry with a fresh `ts` is unverified
// (research S3, #448). `timestamp_out_of_tolerance` is answered 401 like every refusal; Paddle retries on any answer but 200, and a
// retry after the clock error is gone applies. If the sandbox shows that retries keep the first `ts`, a wider tolerance covers the
// retry window and costs no safety: the signature still binds body and secret, and the dedupe on the event id stops a replay.
import "server-only";
import type { Kysely } from "kysely";
import {
  createBillingWebhookEventsRepository,
  type WebhookEventInput,
} from "../db/repositories/billing-webhook-events-repository.ts";
import type { PaddleEnv } from "../db/repositories/billing-plan-prices-repository.ts";
import type { Database } from "../db/schema.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import type { WebhookOutcome } from "./subscription-state.ts";
import type { ApplyContext, WebhookLogger } from "./webhook-context.ts";
import { PADDLE_WEBHOOK_EVENTS } from "./webhook-events.ts";
import { applyPriceEvent } from "./webhook-price.ts";
import {
  PLAIN_IDENTIFIER,
  canonicalTime,
  webhookEnvelopeSchema,
} from "./webhook-schemas.ts";
import { applySubscriptionEvent } from "./webhook-subscription.ts";
import {
  PADDLE_SIGNATURE_TOLERANCE_SECONDS,
  verifyPaddleSignature,
} from "./webhook-verify.ts";

export type { WebhookLogger } from "./webhook-context.ts";

/** Paddle's notifications are a few kilobytes; a signed body far beyond that is not one. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * The tolerance of `ts`: the verifier's default of five minutes until the sandbox says (research S3, #448) whether a retry is
 * signed afresh. See the header of this file for the fallback.
 */
export const BILLING_WEBHOOK_TOLERANCE_SECONDS =
  PADDLE_SIGNATURE_TOLERANCE_SECONDS;

export type WebhookConfig = {
  /** The secret of the notification destination. */
  secret: string;
  /** The Paddle environment this instance is configured for; events are applied to rows of that environment only. */
  environment: PaddleEnv;
};

export type BillingWebhookDeps = {
  db: Kysely<Database>;
  /** The secret and the environment, or undefined when the secret cannot be read. Called for each request: nothing is cached. */
  config: () => Promise<WebhookConfig | undefined>;
  now?: () => Date;
  toleranceSeconds?: number;
  maxBodyBytes?: number;
  logger?: WebhookLogger;
};

const consoleLogger: WebhookLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

/** A refusal: a status and nothing else. */
function refuse(status: number): Response {
  return new Response(null, { status });
}

const HANDLED = new Set<string>(PADDLE_WEBHOOK_EVENTS);

async function applyEvent(context: ApplyContext): Promise<WebhookOutcome> {
  if (!HANDLED.has(context.eventType)) return "ignored_type";
  switch (context.eventType) {
    case "subscription.created":
    case "subscription.updated":
    case "subscription.canceled":
      return applySubscriptionEvent(context);
    case "price.created":
    case "price.updated":
      return applyPriceEvent(context);
    // The subscription events carry the state; these are recorded so the log shows them, and change nothing.
    default:
      return "informational";
  }
}

/** The Paddle id of the thing the event is about, for the log, when the data has one that looks like an id. */
function entityIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("id" in data)) return null;
  const id = data.id;
  return typeof id === "string" && PLAIN_IDENTIFIER.test(id) ? id : null;
}

export function createBillingWebhookHandler(
  deps: BillingWebhookDeps,
): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? consoleLogger;
  const maxBodyBytes = deps.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;
  const toleranceSeconds =
    deps.toleranceSeconds ?? BILLING_WEBHOOK_TOLERANCE_SECONDS;

  return async function handle(request) {
    const config = await deps.config().catch(() => undefined);
    if (config === undefined) {
      logger.error(
        "[billing] BILLING_WEBHOOK_UNVERIFIABLE: the webhook secret cannot be read.",
      );
      return refuse(503);
    }

    const body = await readLimitedBody(request, maxBodyBytes);
    if (!body.ok) return refuse(413);

    const verdict = verifyPaddleSignature({
      header: request.headers.get("paddle-signature"),
      rawBody: body.text,
      secret: config.secret,
      now: now(),
      toleranceSeconds,
    });
    if (!verdict.ok) {
      // A code, nothing of the request: it is not trusted yet.
      logger.error(`[billing] BILLING_WEBHOOK_REJECTED code=${verdict.code}`);
      return refuse(401);
    }

    // Signed by Paddle (or by whoever holds the secret): now the bytes may be read.
    const envelope = parseEnvelope(body.text);
    if (envelope === undefined) {
      logger.error("[billing] BILLING_WEBHOOK_MALFORMED: not a Paddle event.");
      return refuse(400);
    }

    const input: WebhookEventInput = {
      eventId: envelope.eventId,
      env: config.environment,
      eventType: envelope.eventType,
      occurredAt: envelope.occurredAt,
      entityId: entityIdOf(envelope.data),
    };
    try {
      const outcome = await deps.db.transaction().execute(async (trx) => {
        const events = createBillingWebhookEventsRepository(trx, now);
        // A duplicate: the first delivery's transaction decided; this one changes nothing.
        if (!(await events.claim(input))) return "duplicate_ignored" as const;
        const applied = await applyEvent({
          db: trx,
          env: config.environment,
          now,
          logger,
          eventId: envelope.eventId,
          eventType: envelope.eventType,
          occurredAt: envelope.occurredAt,
          data: envelope.data,
        });
        await events.setOutcome(envelope.eventId, applied);
        return applied;
      });
      return Response.json(
        { outcome },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    } catch {
      // No error text: it could carry whatever the failing layer held. The event id is Paddle's and says which one to look for.
      logger.error(
        `[billing] BILLING_WEBHOOK_FAILED event=${envelope.eventId}: the event was not applied, Paddle will retry.`,
      );
      return refuse(500);
    }
  };
}

function parseEnvelope(text: string) {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = webhookEnvelopeSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const occurredAt = canonicalTime(parsed.data.occurred_at);
  if (occurredAt === undefined) return undefined;
  return {
    eventId: parsed.data.event_id,
    eventType: parsed.data.event_type,
    occurredAt,
    data: parsed.data.data,
  };
}
