// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the three public routes of the sign-up and the email verification, with their
// collaborators passed in so the route files only wire the real ones and tests wire fakes:
//
//   POST /api/sign-up                { email, password }   creates an account when the rule lets the address in
//   POST /api/verify-email           { token, password }   verifies the address a link was made for, with
//                                                          the password of the sign-up that made it
//   POST /api/verify-email/resend    { email }             sends a new link
//
// All three are public: the visitor has no session yet (or, for a link, the token is the credential).
// Each reads its request through `readJsonObject`: same site, `application/json` only, a size limit, read
// and parsed once, and everything behind it uses those parsed values (nothing here hands the request on
// to a second parser). Every refusal is `{ "error": <code> }` with a stable code, `Cache-Control:
// no-store`, and never an address, a password or a token. The answers do not depend on whether an address
// has an account or is allowed (src/signup/sign-up.ts, resend.ts).
import {
  readJsonObject,
  JSON_BODY_ERROR_STATUS,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import type { ResendOutcome } from "./resend.ts";
import type { SignUpIssue, SignUpOutcome } from "./sign-up.ts";
import type { SignUpUnavailableCode } from "./availability.ts";
import type { SignUpLimits } from "./limits.ts";
import {
  findVerificationToken,
  isWellFormedVerificationToken,
  type VerificationErrorCode,
  type VerificationResult,
} from "./verification-tokens.ts";

/** An email address, a password of at most 128 characters, or a token: a few hundred bytes. */
export const SIGN_UP_REQUEST_MAX_BYTES = 4 * 1024;

export const SIGN_UP_ERROR_STATUS = {
  ...JSON_BODY_ERROR_STATUS,
  signup_closed: 403,
  sign_up_disabled: 403,
  rate_limited: 429,
  unavailable: 503,
  /** Resend while the instance has no mail server. */
  not_available: 404,
  invalid_token: 400,
  token_expired: 410,
  token_used: 409,
} as const satisfies Record<
  | JsonBodyErrorCode
  | SignUpUnavailableCode
  | VerificationErrorCode
  | "rate_limited"
  | "unavailable"
  | "not_available",
  number
>;
export type SignUpErrorCode = keyof typeof SIGN_UP_ERROR_STATUS;

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: SignUpErrorCode,
  extra: { issues?: SignUpIssue[]; retryAfter?: number } = {},
): Response {
  return Response.json(
    { error: code, ...(extra.issues ? { issues: extra.issues } : {}) },
    {
      status: SIGN_UP_ERROR_STATUS[code],
      headers: {
        ...NO_STORE,
        ...(extra.retryAfter === undefined
          ? {}
          : { "retry-after": String(extra.retryAfter) }),
      },
    },
  );
}

export type SignUpRouteDependencies = {
  signUp: (input: {
    email: unknown;
    password: unknown;
  }) => Promise<SignUpOutcome>;
  resend: (email: unknown) => Promise<ResendOutcome>;
  /** The id of the user the request is signed in as, or null. */
  currentUserId: (request: Request) => Promise<string | null>;
  database: Parameters<typeof findVerificationToken>[0];
  limits: SignUpLimits;
  verify: (token: unknown, password: unknown) => Promise<VerificationResult>;
  log?: (message: string) => void;
};

export type SignUpRouteHandlers = {
  signUp(request: Request): Promise<Response>;
  verify(request: Request): Promise<Response>;
  resend(request: Request): Promise<Response>;
};

export function createSignUpRouteHandlers({
  signUp,
  resend,
  currentUserId,
  database,
  limits,
  verify,
  log = console.error,
}: SignUpRouteDependencies): SignUpRouteHandlers {
  // A failure of the database or of the counters is never a free pass: the request is not served.
  function unavailable(code: string, error: unknown): Response {
    log(
      `[signup] ${code}: the request could not be served (${error instanceof Error ? error.name : "error"}).`,
    );
    return refusal("unavailable");
  }

  return {
    async signUp(request) {
      const body = await readJsonObject(request, SIGN_UP_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      let outcome: SignUpOutcome;
      try {
        outcome = await signUp({
          email: body.value.email,
          password: body.value.password,
        });
      } catch (error) {
        return unavailable("SIGN_UP_UNAVAILABLE", error);
      }
      switch (outcome.kind) {
        case "accepted":
          return Response.json(
            { ok: true, next: outcome.next },
            { headers: NO_STORE },
          );
        case "unavailable":
          return refusal(outcome.error);
        case "invalid":
          return refusal("invalid_input", { issues: outcome.issues });
        case "rate_limited":
          return refusal("rate_limited", {
            retryAfter: outcome.retryAfterSeconds,
          });
      }
    },

    async resend(request) {
      const body = await readJsonObject(request, SIGN_UP_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      let outcome: ResendOutcome;
      try {
        outcome = await resend(body.value.email);
      } catch (error) {
        return unavailable("VERIFICATION_RESEND_UNAVAILABLE", error);
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
    },

    async verify(request) {
      const body = await readJsonObject(request, SIGN_UP_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const { token, password } = body.value;
      if (!isWellFormedVerificationToken(token))
        return refusal("invalid_token");

      try {
        // Only attempts against a link that exists are counted: junk can never use up the attempts of a
        // person's valid link.
        const known = await findVerificationToken(database, token);
        if (known === null) return refusal("invalid_token");
        const permission = await limits.verifyToken(known.tokenHash);
        if (!permission.allowed)
          return refusal("rate_limited", {
            retryAfter: permission.retryAfterSeconds,
          });

        // A link opened in a browser that is signed in as somebody else verifies nothing: it is not
        // theirs, and the answer is the one of any link that does not work.
        const signedInAs = await currentUserId(request);
        if (signedInAs !== null && signedInAs !== known.userId)
          return refusal("invalid_token");

        const result = await verify(token, password);
        if (result.ok)
          return Response.json({ ok: true }, { headers: NO_STORE });
        return refusal(result.error);
      } catch (error) {
        return unavailable("VERIFY_EMAIL_UNAVAILABLE", error);
      }
    },
  };
}
