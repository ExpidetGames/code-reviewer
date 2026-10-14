// SPDX-License-Identifier: Apache-2.0

// The handlers behind linking a GitHub identity (see link.ts), with their collaborators passed in so the
// route files only wire the real ones and tests wire fakes:
//
//   POST /api/account/github/link    starts the linking from the account's page: answers { url }, the
//                                    address of GitHub's authorization page
//   GET  /api/auth/callback/github   where GitHub sends the browser back; this handler takes only the
//                                    requests whose `state` is one of ours (it contains a dot; Better Auth's
//                                    own are plain random text) and answers a redirect to a fixed page with
//                                    the outcome in the query. Everything else goes to Better Auth.
//
// Every answer is `Cache-Control: no-store`; the callback sends `Referrer-Policy: no-referrer` so the code
// and the state in its address never travel in a header.
import type { SessionUser } from "../auth/access-policy.ts";
import { JSON_BODY_ERROR_STATUS, readJsonObject } from "../http/json-body.ts";
import {
  LINK_ERROR_CODES,
  LINK_RETURN_PAGE,
  type GithubLinkService,
  type LinkErrorCode,
} from "./link.ts";

const NO_STORE = { "cache-control": "no-store" };
const REQUEST_MAX_BYTES = 1024;

export const LINK_CALLBACK_PATH = "/api/auth/callback/github";

function refusal(
  error: string,
  status: number,
  retryAfterSeconds?: number,
): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        ...NO_STORE,
        ...(retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(retryAfterSeconds) }),
      },
    },
  );
}

/** Whether a `state` parameter is one of ours: a signed value, `<payload>.<mac>`. Better Auth's has no dot. */
export function isLinkState(state: string | null): boolean {
  return state !== null && state.includes(".");
}

export type StartLinkHandlerDependencies = {
  /** Whoever is signed in (the second guard behind the proxy). Throws, as `requireUser` does, when nobody is. */
  requireUser: () => Promise<SessionUser>;
  sessionId: () => Promise<string | null>;
  service: GithubLinkService;
};

/** `POST` handler that starts the linking and answers the address to go to. */
export function createStartLinkHandler({
  requireUser,
  sessionId,
  service,
}: StartLinkHandlerDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const user = await requireUser();
    const body = await readJsonObject(request, REQUEST_MAX_BYTES);
    if (!body.ok)
      return refusal(body.error, JSON_BODY_ERROR_STATUS[body.error]);
    const session = await sessionId();
    if (session === null) return refusal("session_required", 401);
    try {
      const result = await service.start({ id: user.id, sessionId: session });
      if (result.ok)
        return Response.json(
          { ok: true, url: result.url },
          { headers: NO_STORE },
        );
      if (result.error === "rate_limited")
        return refusal("rate_limited", 429, result.retryAfterSeconds);
      return refusal(
        result.error,
        result.error === "invalid_input" ? 422 : 409,
      );
    } catch {
      console.error(
        "[github-link] LINK_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable", 503);
    }
  };
}

export type LinkCallbackHandlerDependencies = {
  /** The person and the session of the request, or null when there is none. */
  session: (request: Request) => Promise<{
    userId: string;
    sessionId: string;
  } | null>;
  service: GithubLinkService;
};

/**
 * The callback of GitHub's authorization for a linking. Resolves to null when the request is not one (the
 * caller hands it to Better Auth), otherwise to the redirect.
 */
export function createLinkCallbackHandler({
  session,
  service,
}: LinkCallbackHandlerDependencies): (
  request: Request,
) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== LINK_CALLBACK_PATH)
      return null;
    if (!isLinkState(url.searchParams.get("state"))) return null;

    const redirectTo = (location: string): Response =>
      new Response(null, {
        status: 302,
        headers: {
          location,
          "referrer-policy": "no-referrer",
          ...NO_STORE,
        },
      });
    let who: { userId: string; sessionId: string } | null;
    try {
      who = await session(request);
    } catch {
      return redirectTo("/login?error=sign_in_unavailable");
    }
    // Nobody is signed in here: a link cannot be completed by somebody else's browser.
    if (who === null) return redirectTo("/login");
    let result: Awaited<ReturnType<GithubLinkService["complete"]>>;
    try {
      result = await service.complete(
        { id: who.userId, sessionId: who.sessionId },
        {
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          error: url.searchParams.get("error"),
        },
      );
    } catch {
      console.error(
        "[github-link] LINK_UNAVAILABLE: the request was not served.",
      );
      return redirectTo(`${LINK_RETURN_PAGE}?github_error=unavailable`);
    }
    const page = LINK_RETURN_PAGE;
    // Only a code of our own list ever appears in the address, nothing GitHub or the request said.
    return redirectTo(
      result.ok
        ? `${page}?github=${result.outcome}`
        : `${page}?github_error=${
            (LINK_ERROR_CODES as readonly string[]).includes(result.error)
              ? (result.error satisfies LinkErrorCode)
              : "unknown"
          }`,
    );
  };
}
