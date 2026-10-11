// SPDX-License-Identifier: Apache-2.0

// The handler behind `POST /api/password-reset/request` { email }: asks for a reset link by mail
// (password-reset-request.ts). Public on purpose: the person has no session, that is why they ask. It reads
// its request exactly once (same site, `application/json`, 4 KB, `src/http/json-body.ts`). The answer is the
// same for every address: 200 `{ ok: true }` whether or not the address has an account. What differs is only
// what does not depend on the address: that the instance cannot send mail (404 `not_available`), that the
// form is wrong (422 `invalid_input`), that the caller is going too fast (429 with `Retry-After`), or that
// the counters could not be read (503, never a free pass). Every refusal is `{ "error": <code> }` with a
// stable code, `Cache-Control: no-store`, and never an address.
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import type { ResetRequestOutcome } from "./password-reset-request.ts";

export const PASSWORD_RESET_REQUEST_MAX_BYTES = 4 * 1024;

export const PASSWORD_RESET_REQUEST_ERROR_STATUS = {
  ...JSON_BODY_ERROR_STATUS,
  not_available: 404,
  rate_limited: 429,
  unavailable: 503,
} as const satisfies Record<
  JsonBodyErrorCode | "not_available" | "rate_limited" | "unavailable",
  number
>;
export type PasswordResetRequestErrorCode =
  keyof typeof PASSWORD_RESET_REQUEST_ERROR_STATUS;

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: PasswordResetRequestErrorCode,
  extra: {
    issues?: Array<{ field: string; code: string }>;
    retryAfter?: number;
  } = {},
): Response {
  return Response.json(
    { error: code, ...(extra.issues ? { issues: extra.issues } : {}) },
    {
      status: PASSWORD_RESET_REQUEST_ERROR_STATUS[code],
      headers: {
        ...NO_STORE,
        ...(extra.retryAfter === undefined
          ? {}
          : { "retry-after": String(extra.retryAfter) }),
      },
    },
  );
}

export function createPasswordResetRequestHandler({
  request: ask,
  log = console.error,
}: {
  request: (email: unknown) => Promise<ResetRequestOutcome>;
  log?: (message: string) => void;
}) {
  return async function post(request: Request): Promise<Response> {
    const body = await readJsonObject(
      request,
      PASSWORD_RESET_REQUEST_MAX_BYTES,
    );
    if (!body.ok) return refusal(body.error);
    let outcome: ResetRequestOutcome;
    try {
      outcome = await ask(body.value.email);
    } catch {
      log(
        "[auth] PASSWORD_RESET_REQUEST_UNAVAILABLE: the request could not be served.",
      );
      return refusal("unavailable");
    }
    switch (outcome.kind) {
      case "accepted":
        return Response.json({ ok: true }, { headers: NO_STORE });
      case "unavailable":
        return refusal("not_available");
      case "invalid":
        return refusal("invalid_input", {
          issues: [{ field: "email", code: "invalid_email" }],
        });
      case "rate_limited":
        return refusal("rate_limited", {
          retryAfter: outcome.retryAfterSeconds,
        });
    }
  };
}
