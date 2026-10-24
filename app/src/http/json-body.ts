// SPDX-License-Identifier: LicenseRef-Proprietary

// The one way a public JSON route reads its request: where the request comes from, then its content type,
// then the body, read exactly once with a hard size limit, then parsed once. Everything the route does
// afterwards (counting an attempt, looking an account up, creating one) works with the same parsed
// values, so a limiter and the code behind it can never see two different readings of one request.
// Only `application/json` is accepted: a body in another format (form encoded, plain text) is where a
// parser can read a different value than the one that was counted.
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { isCrossSite, isJsonRequest } from "./request-checks.ts";

export const JSON_BODY_ERROR_CODES = [
  "cross_site_request",
  "unsupported_content_type",
  "body_too_large",
  /** The body is not a JSON object. */
  "invalid_input",
] as const;
export type JsonBodyErrorCode = (typeof JSON_BODY_ERROR_CODES)[number];

export const JSON_BODY_ERROR_STATUS: Record<JsonBodyErrorCode, number> = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
};

export type JsonBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: JsonBodyErrorCode };

export async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<JsonBody> {
  if (isCrossSite(request)) return { ok: false, error: "cross_site_request" };
  if (!isJsonRequest(request))
    return { ok: false, error: "unsupported_content_type" };
  const body = await readLimitedBody(request, maxBytes);
  if (!body.ok) return { ok: false, error: "body_too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { ok: false, error: "invalid_input" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: "invalid_input" };
  return { ok: true, value: parsed as Record<string, unknown> };
}
