// SPDX-License-Identifier: Apache-2.0

// The handler behind `POST /api/password-reset` { token, password }: sets a new password with a reset
// link (password-reset.ts). Public on purpose: the token in the link is the credential, 256 random bits
// that cannot be guessed, so a limit on junk would buy nothing and would only get in the way of recovery:
// a limit shared by everybody lets anyone lock the operator out of the very route `admin reset-password`
// exists for. The limit is therefore per token: attempts against a token that exists are counted in the
// shared `rate_limits` table (key `password-reset:<hash of the token>`, 10 in the 30 minutes a link
// lives), because that is where a password hash can be asked for again and again. A token that does
// not exist gets the same generic answer and touches no counter. Order: where the request comes from,
// its content type and body, the token, the limit, then the reset. Every refusal is `{ "error": <code> }`
// with a stable code, `Cache-Control: no-store`, and never the token or the password.
import { RESET_TOKEN_TTL_MS, hashResetToken } from "../admin-cli/token.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { PasswordResetResult } from "./password-reset.ts";

export const PASSWORD_RESET_MAX_ATTEMPTS = 10;
export const PASSWORD_RESET_WINDOW_MS = RESET_TOKEN_TTL_MS;
/** The counter of one link. */
export function passwordResetKey(token: string): string {
  return `password-reset:${hashResetToken(token)}`;
}
/** A token and a password of at most 128 characters. */
export const PASSWORD_RESET_REQUEST_MAX_BYTES = 8 * 1024;

export const PASSWORD_RESET_ERROR_STATUS = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
  invalid_token: 400,
  rate_limited: 429,
  unavailable: 503,
} as const;
export type PasswordResetErrorCode = keyof typeof PASSWORD_RESET_ERROR_STATUS;

export type PasswordResetRouteDependencies = {
  rateLimits: RateLimitsRepository;
  /** Whether a link with this token was ever made (used or expired links count). */
  isKnownToken: (token: string) => Promise<boolean>;
  complete: (input: {
    token: unknown;
    password: unknown;
  }) => Promise<PasswordResetResult>;
  now?: () => Date;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: PasswordResetErrorCode,
  extra: {
    issues?: Array<{ field: string; code: string }>;
    retryAfter?: number;
  } = {},
): Response {
  return Response.json(
    { error: code, ...(extra.issues ? { issues: extra.issues } : {}) },
    {
      status: PASSWORD_RESET_ERROR_STATUS[code],
      headers: {
        ...NO_STORE,
        ...(extra.retryAfter === undefined
          ? {}
          : { "retry-after": String(extra.retryAfter) }),
      },
    },
  );
}

export function createPasswordResetHandler({
  rateLimits,
  isKnownToken,
  complete,
  now = () => new Date(),
}: PasswordResetRouteDependencies) {
  return async function post(request: Request): Promise<Response> {
    if (isCrossSite(request)) return refusal("cross_site_request");
    if (!isJsonRequest(request)) return refusal("unsupported_content_type");
    const body = await readLimitedBody(
      request,
      PASSWORD_RESET_REQUEST_MAX_BYTES,
    );
    if (!body.ok) return refusal("body_too_large");

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return refusal("invalid_input", {
        issues: [{ field: "", code: "body_invalid" }],
      });
    const { token, password } = parsed as {
      token?: unknown;
      password?: unknown;
    };
    if (typeof token !== "string" || typeof password !== "string")
      return refusal("invalid_input", {
        issues: [
          {
            field: typeof token !== "string" ? "token" : "password",
            code: "body_invalid",
          },
        ],
      });

    // Only attempts against a link that exists are counted. No answer from the counters is a no, not a
    // free pass.
    try {
      if (await isKnownToken(token)) {
        const hit = await rateLimits.hit(
          passwordResetKey(token),
          PASSWORD_RESET_WINDOW_MS,
        );
        if (hit.count > PASSWORD_RESET_MAX_ATTEMPTS)
          return refusal("rate_limited", {
            retryAfter: Math.max(
              1,
              Math.ceil(
                (hit.windowStartedAt.getTime() +
                  PASSWORD_RESET_WINDOW_MS -
                  now().getTime()) /
                  1000,
              ),
            ),
          });
      }
    } catch {
      console.error(
        "[auth] PASSWORD_RESET_LIMIT_UNAVAILABLE: the attempts could not be counted.",
      );
      return refusal("unavailable");
    }

    const result = await complete({ token, password });
    if (result.ok) return Response.json({ ok: true }, { headers: NO_STORE });
    if (result.error === "invalid_password")
      return refusal("invalid_input", {
        issues: [{ field: "password", code: result.code }],
      });
    return refusal("invalid_token");
  };
}
