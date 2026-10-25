// SPDX-License-Identifier: LicenseRef-Proprietary

// The verification both signed routes share (`POST /dispatch`, `POST /stop`; contracts/dispatch-webhook.v1.json): the
// content type and the size, the form of the headers, the clock (+/- 5 minutes), the key (the current and the previous
// one) and the signature in constant time. Only after all of that is the body parsed. Every refusal of one kind has the
// same answer, so a caller cannot tell which check failed, and nothing here logs a key, a signature or a body.
import type { Context } from "hono";
import type { Logger } from "../core/types.ts";
import { verifyDispatchSignature, type SigningKey } from "./signature.ts";

/** The body of a signed call is at most 1 KiB (the contract). */
export const MAX_BODY_BYTES = 1024;
export const TOLERANCE_SECONDS = 300;

export type VerifiedRequestOptions = {
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

export function refuse(c: Context, kind: keyof typeof REFUSALS): Response {
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

/** The body as text, or a word when it is longer than `max` bytes (the rest is not read) or not UTF-8. */
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

export type Verified =
  { ok: true; text: string; id: string } | { ok: false; response: Response };

/**
 * Checks, in the contract's order, everything but the body's own form. `id` is the `x-dispatch-id` header, which the
 * signature covers: the id of the wake-up call, or the stop id of a stop call. `refusedEvent` names the log line of a
 * refusal (the verdict only, never a value).
 */
export async function verifyRequest(
  c: Context,
  options: VerifiedRequestOptions & { logger: Logger; refusedEvent: string },
): Promise<Verified> {
  const nowSeconds =
    options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const request = c.req.raw;
  if (!isJson(request.headers.get("content-type") ?? undefined))
    return { ok: false, response: refuse(c, "invalid") };
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    /^\d+$/.test(declared) &&
    Number(declared) > MAX_BODY_BYTES
  )
    return { ok: false, response: refuse(c, "too_large") };
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === "too_large")
    return { ok: false, response: refuse(c, "too_large") };
  if (body === "invalid") return { ok: false, response: refuse(c, "invalid") };

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
    toleranceSeconds: options.toleranceSeconds ?? TOLERANCE_SECONDS,
  });
  if (verdict !== "ok") {
    options.logger.warn(options.refusedEvent, { verdict });
    return {
      ok: false,
      response: refuse(c, verdict === "malformed" ? "invalid" : "unauthorized"),
    };
  }
  return {
    ok: true,
    text: body.text,
    // `verifyDispatchSignature` proved the header is there.
    id: request.headers.get("x-dispatch-id") ?? "",
  };
}
