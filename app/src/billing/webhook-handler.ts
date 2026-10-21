// SPDX-License-Identifier: Apache-2.0

// The handler behind `POST /api/billing/webhook` (ADR 0006, 2.12; #497): generic, the same for every provider. It is a
// function of its collaborators, so the route file only wires the real ones in (`shared.ts`) and tests wire fakes in.
//
// The order is the contract; each step ends the request on failure:
//
//   0. guard      billing off, or no active adapter with a webhook (`manual`): the 404 of a path that does not exist,
//                 before the body is read and before any billing table is touched
//   1. size       the raw body is read with a hard limit                            413, empty body
//   2. verify     `adapter.verifyAndParseWebhook` over the exact bytes: the signature first, the body only after
//                 it; a body is data until then                                     401 (400 for a signed body the
//                                                                                   adapter cannot read), empty body
//   3. apply      `applyBillingEvent`: one transaction, the whole event or nothing   200 and the outcome code (also for
//                 a signed event that is no normalized event, `event_invalid`, and for a paid-but-not-credited
//                 outcome: both are recorded for review and logged at error level, since a retry changes nothing)
//   *  retry      a refund or dispute whose payment is not credited yet               503, empty body: the provider
//                 delivers it again after the credit; nothing was claimed
//   *  failure    anything that throws                                              500, empty body
//
// The answer never carries anything of the request, and the log lines name a code only: no body, no header, no signature,
// no id, no amount, no error message (an error may quote a statement or a value). There is NO outbound call here: the
// event holds everything needed, and a provider that is slow or down must not slow the answer (the route has to answer
// within a few seconds, docs/deployment-vercel.md).
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import {
  BillingAdapterError,
  type BillingAdapter,
  type BillingWebhookRejectionCode,
  type WebhookResult,
} from "./adapter.ts";
import { applyBillingEvent, BillingEventRetryError } from "./apply-event.ts";
import { guardBillingRoute, type BillingRouteGuard } from "./enabled.ts";

/** A signed event is a few kilobytes; 256 KiB is far above any and far below anything that costs memory. */
export const BILLING_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/** What the status of a refusal is, by the adapter's code. */
export const BILLING_WEBHOOK_REJECTION_STATUS = {
  signature_missing: 401,
  signature_invalid: 401,
  signature_expired: 401,
  body_invalid: 400,
} as const satisfies Record<BillingWebhookRejectionCode, 400 | 401>;

/** The codes of the log lines of the route, the only thing it writes about a request. */
export const BILLING_WEBHOOK_LOG_CODES = [
  "billing_webhook_rejected",
  "billing_webhook_too_large",
  "billing_webhook_adapter_failed",
  "billing_webhook_failed",
  "billing_webhook_applied",
  /** A signed event that is not a normalized event: answered 200 and recorded, and the operator must look (error). */
  "billing_webhook_event_invalid",
  /** Money moved or was claimed to move and the ledger did not change: a buyer may have paid for nothing (error). */
  "billing_webhook_needs_review",
  /** A refund or dispute whose payment is not credited yet: answered 503 so the provider delivers it again (error). */
  "billing_webhook_credit_pending",
] as const;

export type BillingWebhookLogger = {
  info(line: string): void;
  error(line: string): void;
};

export const consoleBillingWebhookLogger: BillingWebhookLogger = {
  info: (line) => console.info(line),
  error: (line) => console.error(line),
};

export type BillingWebhookDeps = {
  db: Kysely<Database>;
  guard: BillingRouteGuard;
  /** The adapter billing is set to, or undefined when none is. */
  activeAdapter: () => Promise<BillingAdapter | undefined>;
  logger?: BillingWebhookLogger;
  now?: () => Date;
  maxBodyBytes?: number;
};

const empty = (status: number) => new Response(null, { status });

export function createBillingWebhookHandler(
  deps: BillingWebhookDeps,
): (request: Request) => Promise<Response> {
  const logger = deps.logger ?? consoleBillingWebhookLogger;
  const now = deps.now ?? (() => new Date());

  return guardBillingRoute(deps.guard, async (request: Request) => {
    const adapter = await deps.activeAdapter();
    if (adapter?.verifyAndParseWebhook === undefined)
      return deps.guard.notFound();

    const body = await readLimitedBody(
      request,
      deps.maxBodyBytes ?? BILLING_WEBHOOK_MAX_BODY_BYTES,
    );
    if (!body.ok) {
      logger.info("billing_webhook_too_large");
      return empty(413);
    }

    let parsed: WebhookResult;
    try {
      parsed = await adapter.verifyAndParseWebhook({
        headers: request.headers,
        rawBody: body.bytes,
        now: now(),
      });
    } catch {
      logger.error("billing_webhook_adapter_failed");
      return empty(500);
    }
    if (!parsed.ok) {
      logger.info(`billing_webhook_rejected code=${parsed.code}`);
      return empty(BILLING_WEBHOOK_REJECTION_STATUS[parsed.code]);
    }

    try {
      const result = await applyBillingEvent(deps.db, {
        provider: adapter.id,
        event: parsed.event,
        now,
      });
      // The answer is 200 in every case: a retry would not change what the provider sent. What the operator must see goes
      // to the error log with a code (and sits in the review list of the event table).
      if (result.outcome === "event_invalid")
        logger.error("billing_webhook_event_invalid");
      else if (result.needsReview)
        logger.error(`billing_webhook_needs_review outcome=${result.outcome}`);
      else logger.info(`billing_webhook_applied outcome=${result.outcome}`);
      return Response.json({ outcome: result.outcome });
    } catch (error) {
      if (error instanceof BillingEventRetryError) {
        logger.error(`billing_webhook_${error.code}`);
        return empty(503);
      }
      logger.error(
        `billing_webhook_failed code=${error instanceof BillingAdapterError ? error.code : "unexpected_error"}`,
      );
      return empty(500);
    }
  });
}
