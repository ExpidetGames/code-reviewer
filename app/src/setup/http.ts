// SPDX-License-Identifier: Apache-2.0

// The handlers behind the two routes of the first-run setup, with their collaborators passed in so
// the route files only wire the real ones and tests wire fakes:
//
//   POST /api/setup/code      { "code": "482913" }  exchanges the setup code for a setup session
//   POST /api/setup/complete  { tenancy, signUp, admin }  finishes the setup
//
// Both exist only while the instance is not set up (afterwards the gate, src/proxy.ts, answers 404,
// and the handlers do not trust that alone). Every refusal is `{ "error": <code> }` with a stable
// code from errors.ts, `Cache-Control: no-store`, and never a digit of the code, a password or a
// token. Order for a change: where the request comes from, then (for the wizard) the setup session,
// then its content type and its body.
import {
  checkSetupSession,
  clearedSetupSessionCookie,
  createSetupSessionToken,
  readSetupSessionCookie,
  setupSessionCookie,
} from "./setup-session.ts";
import type { SetupCodeGuard } from "./code-store.ts";
import type { CompletedSetup } from "./complete.ts";
import {
  SETUP_ERROR_STATUS,
  SetupError,
  type SetupErrorCode,
  type SetupIssue,
} from "./errors.ts";
import { parseSetupInput, type SetupInput } from "./input.ts";
import type { SetupStateReader } from "./state.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";

/** The code form sends a few bytes. */
export const SETUP_CODE_REQUEST_MAX_BYTES = 1024;
/** The wizard sends at most 500 entries of up to 254 characters, and a password. */
export const SETUP_COMPLETE_REQUEST_MAX_BYTES = 256 * 1024;

export type SetupRouteDependencies = {
  /** The master key: signs the setup session. */
  appSecret: string;
  /** Whether the cookies get the `Secure` attribute (the app is served over https). */
  secureCookies: boolean;
  /** The setup code: in memory on a server, in the database in a serverless deployment (#321). */
  store: SetupCodeGuard;
  readState: SetupStateReader;
  /** Creates the admin and finishes the setup (complete.ts, with the real hash and database). */
  complete: (input: SetupInput) => Promise<CompletedSetup>;
  /**
   * Signs the new admin in and returns the `Set-Cookie` lines of the session, or null when that was
   * not possible (the admin signs in on the login page instead).
   */
  signInAdmin: (
    email: string,
    password: string,
    requestHeaders: Headers,
  ) => Promise<string[] | null>;
  /**
   * Runs once, after the setup is complete and the admin is signed in. The synchronization with
   * GitHub that ran at start could not put a new connection into a workspace while the instance was
   * not set up; this runs it again. Must not throw or wait (the answer does not depend on it).
   */
  afterCompleted?: () => void;
  now?: () => number;
  log?: (message: string) => void;
};

export type SetupRouteHandlers = {
  submitCode(request: Request): Promise<Response>;
  complete(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: SetupErrorCode,
  extra: { issues?: SetupIssue[]; headers?: Record<string, string> } = {},
): Response {
  return Response.json(
    {
      error: code,
      ...(extra.issues !== undefined && extra.issues.length > 0
        ? { issues: extra.issues }
        : {}),
    },
    {
      status: SETUP_ERROR_STATUS[code],
      headers: { ...NO_STORE, ...extra.headers },
    },
  );
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<
  { ok: true; value: unknown } | { ok: false; error: SetupErrorCode }
> {
  if (!isJsonRequest(request))
    return { ok: false, error: "unsupported_content_type" };
  const body = await readLimitedBody(request, maxBytes);
  if (!body.ok) return { ok: false, error: "body_too_large" };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: true, value: undefined };
  }
}

export function createSetupRouteHandlers(
  deps: SetupRouteDependencies,
): SetupRouteHandlers {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.error(message));

  return {
    async submitCode(request) {
      // Once the instance is set up the setup does not exist.
      if ((await deps.readState()).kind === "completed")
        return refusal("not_found");
      if (isCrossSite(request)) return refusal("cross_site_request");
      const body = await readJson(request, SETUP_CODE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);

      const submitted =
        typeof body.value === "object" && body.value !== null
          ? (body.value as { code?: unknown }).code
          : undefined;
      const attempt = await deps.store.attempt(submitted);
      if (!attempt.ok)
        return refusal(attempt.error, {
          headers:
            attempt.error === "rate_limited" &&
            attempt.retryAfterSeconds !== undefined
              ? { "retry-after": String(attempt.retryAfterSeconds) }
              : {},
        });

      const token = createSetupSessionToken(
        deps.appSecret,
        attempt.issueId,
        now(),
      );
      const headers = new Headers(NO_STORE);
      headers.append(
        "set-cookie",
        setupSessionCookie(token, deps.secureCookies),
      );
      return Response.json({ ok: true }, { headers });
    },

    async complete(request) {
      if ((await deps.readState()).kind === "completed")
        return refusal("already_set_up");
      if (isCrossSite(request)) return refusal("cross_site_request");

      const session = checkSetupSession(
        deps.appSecret,
        readSetupSessionCookie(request.headers.get("cookie")),
        await deps.store.currentIssueId(),
        now(),
      );
      if (!session.ok)
        return refusal(
          session.reason === "expired"
            ? "setup_session_expired"
            : "setup_session_required",
        );

      const body = await readJson(request, SETUP_COMPLETE_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const parsed = parseSetupInput(body.value);
      if (!parsed.ok)
        return refusal("invalid_input", { issues: parsed.issues });

      try {
        await deps.complete(parsed.input);
      } catch (error) {
        if (error instanceof SetupError)
          return refusal(error.code, { issues: error.issues });
        throw error;
      }
      // The code and the setup session are worthless from here on.
      try {
        await deps.store.invalidate();
      } catch {
        // The instance is set up either way (the routes answer 404 from here on); the code row is
        // only housekeeping. Never the reason: it could quote a statement.
        log(
          "[setup] SETUP_CODE_INVALIDATE_FAILED: the setup is complete, but the stored setup code could not be removed.",
        );
      }

      const headers = new Headers(NO_STORE);
      headers.append(
        "set-cookie",
        clearedSetupSessionCookie(deps.secureCookies),
      );
      let signedIn = false;
      try {
        const cookies = await deps.signInAdmin(
          parsed.input.admin.email,
          parsed.input.admin.password,
          request.headers,
        );
        for (const cookie of cookies ?? [])
          headers.append("set-cookie", cookie);
        signedIn = cookies !== null && cookies.length > 0;
      } catch {
        // Never the reason: it could quote the request.
        log(
          "[setup] SETUP_SIGN_IN_FAILED: the new admin could not be signed in automatically.",
        );
      }
      try {
        deps.afterCompleted?.();
      } catch {
        log(
          "[setup] SETUP_AFTER_COMPLETED_FAILED: a follow-up step after the setup failed.",
        );
      }
      return Response.json(
        { ok: true, redirectTo: signedIn ? "/admin" : "/login" },
        { headers },
      );
    },
  };
}
