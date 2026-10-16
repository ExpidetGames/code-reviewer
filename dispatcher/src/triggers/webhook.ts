// SPDX-License-Identifier: Apache-2.0

// The Webhook-Trigger: POST /dispatch, the signed wake-up call of the App
// (contracts/dispatch-webhook.v1.json). It verifies, in the contract's order, the content type and the
// size, the headers' form, the clock (+/- 5 minutes), the key (the current and the previous one) and the
// signature in constant time, and only then reads the closed body. It claims exactly that job and answers
// at once: 202 when the Worker is being started (the launch goes on in the background), 200 ignored when
// there is nothing to start, 429 or 503 with Retry-After when the Dispatcher cannot take it now. Every
// refusal of the same kind has the same answer, and no answer or log holds a secret.
import type { Context, Hono } from "hono";
import type { HandleResult } from "../core/types.ts";
import { verifyDispatchSignature, type SigningKey } from "./signature.ts";
import type { Trigger, TriggerContext } from "./types.ts";
import { DispatchWebhookSchema } from "./webhook-schema.ts";

/** The body of the call is at most 1 KiB (the contract). */
export const MAX_BODY_BYTES = 1024;
export const TOLERANCE_SECONDS = 300;

export type WebhookTriggerOptions = {
  /** The key the App signs with now, and the previous one while a rotation is in progress. */
  keys: readonly SigningKey[];
  nowSeconds?: () => number;
  toleranceSeconds?: number;
};

const REFUSALS = {
  unauthorized: {
    status: 401,
    code: "RUNNER_UNAUTHORIZED",
    message: "The request could not be verified.",
  },
  invalid: {
    status: 400,
    code: "RUNNER_REQUEST_INVALID",
    message: "The request is not valid.",
  },
  too_large: {
    status: 413,
    code: "RUNNER_BODY_TOO_LARGE",
    message: "The request body is too large.",
  },
} as const;

function refuse(c: Context, kind: keyof typeof REFUSALS): Response {
  const { status, code, message } = REFUSALS[kind];
  return c.json({ error: { code, message } }, status);
}

function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const [type, ...parameters] = contentType
    .split(";")
    .map((part) => part.trim().toLowerCase());
  return (
    type === "application/json" &&
    parameters.every((parameter) => parameter === "charset=utf-8")
  );
}

/** The body as text, or null when it is longer than `max` bytes (the rest is not read) or not UTF-8. */
async function readBody(
  request: Request,
  max: number,
): Promise<{ text: string } | "too_large" | "invalid"> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return "invalid";
  }
}

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
  const nowSeconds =
    options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const tolerance = options.toleranceSeconds ?? TOLERANCE_SECONDS;

  return {
    mount(app: Hono, context: TriggerContext) {
      app.post("/dispatch", async (c) => {
        const request = c.req.raw;
        if (!isJson(request.headers.get("content-type") ?? undefined))
          return refuse(c, "invalid");
        const declared = request.headers.get("content-length");
        if (
          declared !== null &&
          /^\d+$/.test(declared) &&
          Number(declared) > MAX_BODY_BYTES
        )
          return refuse(c, "too_large");
        const body = await readBody(request, MAX_BODY_BYTES);
        if (body === "too_large") return refuse(c, "too_large");
        if (body === "invalid") return refuse(c, "invalid");

        const verdict = verifyDispatchSignature({
          keys: options.keys,
          headers: {
            "x-dispatch-timestamp":
              request.headers.get("x-dispatch-timestamp") ?? undefined,
            "x-dispatch-id": request.headers.get("x-dispatch-id") ?? undefined,
            "x-dispatch-signature":
              request.headers.get("x-dispatch-signature") ?? undefined,
            "x-dispatch-key-id":
              request.headers.get("x-dispatch-key-id") ?? undefined,
          },
          rawBody: body.text,
          nowSeconds: nowSeconds(),
          toleranceSeconds: tolerance,
        });
        if (verdict !== "ok") {
          context.logger.warn("dispatch_refused", { verdict });
          return refuse(
            c,
            verdict === "malformed" ? "invalid" : "unauthorized",
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body.text);
        } catch {
          return refuse(c, "invalid");
        }
        const webhook = DispatchWebhookSchema.safeParse(parsed);
        if (
          !webhook.success ||
          webhook.data.dispatchId !== request.headers.get("x-dispatch-id")
        ) {
          context.logger.warn("dispatch_refused", { verdict: "body_invalid" });
          return refuse(c, "invalid");
        }

        const { jobId, reviewKind, attempt } = webhook.data;
        context.logger.info("dispatch_received", {
          jobId,
          reviewKind,
          attempt,
        });
        const result = await context.core.handle({ jobId, reviewKind });
        return answer(c, result, context);
      });
    },
  };
}
