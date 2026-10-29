// SPDX-License-Identifier: LicenseRef-Proprietary

// The Webhook-Trigger: POST /dispatch, the signed wake-up call of the App
// (contracts/dispatch-webhook.v1.json). It verifies, in the contract's order, the content type and the
// size, the headers' form, the clock (+/- 5 minutes), the key (the current and the previous one) and the
// signature in constant time, and only then reads the closed body. It claims exactly that job and answers
// at once: 202 when the Worker is being started (the launch goes on in the background), 200 ignored when
// there is nothing to start, 429 or 503 with Retry-After when the Dispatcher cannot take it now. Every
// refusal of the same kind has the same answer, and no answer or log holds a secret.
import type { Context, Hono } from "hono";
import type { HandleResult } from "../core/types.ts";
import type { Trigger, TriggerContext } from "./types.ts";
import {
  MAX_BODY_BYTES,
  TOLERANCE_SECONDS,
  refuse,
  verifyRequest,
  type VerifiedRequestOptions,
} from "./verified-request.ts";
import { DispatchWebhookSchema } from "./webhook-schema.ts";

export { MAX_BODY_BYTES, TOLERANCE_SECONDS };

export type WebhookTriggerOptions = VerifiedRequestOptions;

function answer(
  c: Context,
  result: HandleResult,
  context: TriggerContext,
): Response {
  switch (result.outcome) {
    case "started":
      context.background(result.background);
      return c.json({ version: 1, status: "accepted" }, 202);
    case "ignored":
      return c.json({ version: 1, status: "ignored", reason: "not_claimable" });
    case "not_capable":
      return c.json({ version: 1, status: "ignored", reason: "not_capable" });
    case "busy":
      return c.body(null, 429, {
        "retry-after": String(result.retryAfterSeconds),
      });
    case "unavailable":
      return c.body(null, 503, {
        "retry-after": String(result.retryAfterSeconds),
      });
  }
}

export function webhookTrigger(options: WebhookTriggerOptions): Trigger {
  return {
    mount(app: Hono, context: TriggerContext) {
      app.post("/dispatch", async (c) => {
        const verified = await verifyRequest(c, {
          ...options,
          logger: context.logger,
          refusedEvent: "dispatch_refused",
        });
        if (!verified.ok) return verified.response;

        let parsed: unknown;
        try {
          parsed = JSON.parse(verified.text);
        } catch {
          return refuse(c, "invalid");
        }
        const webhook = DispatchWebhookSchema.safeParse(parsed);
        if (!webhook.success || webhook.data.dispatchId !== verified.id) {
          context.logger.warn("dispatch_refused", { verdict: "body_invalid" });
          return refuse(c, "invalid");
        }

        const { jobId, reviewKind, attempt } = webhook.data;
        context.logger.info("dispatch_received", {
          app: verified.appId,
          jobId,
          reviewKind,
          attempt,
        });
        // The app is the one whose key verified the call: the body has no say in it.
        const result = await context.core.handle({
          appId: verified.appId,
          jobId,
          reviewKind,
        });
        return answer(c, result, context);
      });
    },
  };
}
