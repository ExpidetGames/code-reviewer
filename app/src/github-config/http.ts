// SPDX-License-Identifier: Apache-2.0

// The handlers behind the GitHub data routes of the admin portal, with their collaborators passed in so the
// route files only wire the real ones and tests wire fakes:
//
//   GET  /api/admin/github                    the integration as the portal shows it (never a secret)
//   PUT  /api/admin/github                    one change; the body has exactly one of
//                                             { "app": { appId, slug, privateKey, webhookSecret, clientId,
//                                                        clientSecret, privateApp } }   (secrets are write-only:
//                                                        an empty one keeps the stored one while the App id,
//                                                        and for the client secret the client id, is unchanged)
//                                             { "userAuthorization": { clientId, clientSecret } }
//                                             { "privateApp": boolean }
//   POST /api/admin/github/manifest           starts the manifest flow: answers { postUrl, manifest }, which the
//                                             browser posts to GitHub (the state is in postUrl)
//   GET  /api/admin/github/manifest/callback  where GitHub sends the browser back (code and state); answers a
//                                             redirect to the GitHub App page, with the result in the query
//   POST /api/admin/github/check              asks GitHub what the App is granted and says what is missing
//   POST /api/admin/github/link               starts the linking of the admin's own GitHub account (and so the
//                                             merge with an imported operator): answers { url }, the address
//                                             of GitHub's authorization page (src/github-signin/link.ts)
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in but
// not an admin is a 404 like for any path that does not exist), then for a change where the request comes
// from, its content type and its body, then the service. Every refusal is `{ "error": <code> }` with a
// stable code from errors.ts, every answer is `Cache-Control: no-store`.
import type { SessionUser } from "../auth/access-policy.ts";
import type { AdminAccess } from "../admin/access.ts";
import { readJsonObject } from "../http/json-body.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import type { GithubLinkService } from "../github-signin/link.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import {
  COMPLETE_MANIFEST_ERROR_CODES,
  type GithubConfigService,
} from "./service.ts";
import { GITHUB_ERROR_STATUS, type GithubErrorCode } from "./errors.ts";

/** A private key and a few secrets: the biggest body is well below this. */
export const GITHUB_REQUEST_MAX_BYTES = 64 * 1024;

/** Where the person lands after the manifest flow: a fixed path, never one taken from the request. */
export const GITHUB_APP_PAGE = "/admin/integrations/github";

export type GithubRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The id of the session of the request, or null. A state is bound to it. */
  sessionId: () => Promise<string | null>;
  /** The 404 for somebody who is not an admin: Next.js's own. Throws. */
  notFound: () => never;
  service: GithubConfigService;
  /** The linking of a GitHub identity; only the route that starts it needs it. */
  link?: GithubLinkService;
};

export type GithubRouteHandlers = {
  get(request: Request): Promise<Response>;
  put(request: Request): Promise<Response>;
  startManifest(request: Request): Promise<Response>;
  manifestCallback(request: Request): Promise<Response>;
  check(request: Request): Promise<Response>;
  startLink(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: GithubErrorCode,
  extra: Record<string, unknown> = {},
  retryAfterSeconds?: number,
): Response {
  return Response.json(
    { error: code, ...extra },
    {
      status: GITHUB_ERROR_STATUS[code],
      headers: {
        ...NO_STORE,
        ...(retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(retryAfterSeconds) }),
      },
    },
  );
}

async function readBody(
  request: Request,
  allowEmpty = false,
): Promise<
  { ok: true; value: unknown } | { ok: false; error: GithubErrorCode }
> {
  if (!isJsonRequest(request))
    return allowEmpty
      ? { ok: true, value: undefined }
      : { ok: false, error: "unsupported_content_type" };
  const body = await readLimitedBody(request, GITHUB_REQUEST_MAX_BYTES);
  if (!body.ok) return { ok: false, error: "body_too_large" };
  if (body.text === "" && allowEmpty) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: true, value: undefined };
  }
}

const SETTING_KEYS = ["app", "userAuthorization", "privateApp"] as const;

export function createGithubRouteHandlers({
  access,
  sessionId,
  notFound,
  service,
  link,
}: GithubRouteDependencies): GithubRouteHandlers {
  // The user first. The proxy has turned these away already; this is the second guard.
  async function admin(): Promise<SessionUser | Response> {
    const who = await access();
    if (who.kind === "anonymous")
      return Response.json(
        { error: "UNAUTHENTICATED" },
        { status: 401, headers: NO_STORE },
      );
    if (who.kind === "not_admin") return notFound();
    return who.user;
  }

  /** Runs a service call; counters or a database that cannot be read are a 503, never a pass. */
  async function guarded<T>(work: () => Promise<T>): Promise<T | Response> {
    try {
      return await work();
    } catch {
      console.error(
        "[github-config] GITHUB_ADMIN_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable");
    }
  }

  function fromServiceFailure(result: {
    error: string;
    [key: string]: unknown;
  }): Response {
    const { error, ...details } = result;
    delete details.ok;
    if (error === "rate_limited") {
      const retry = Number(details.retryAfterSeconds);
      delete details.retryAfterSeconds;
      return refusal("rate_limited", details, retry);
    }
    return refusal(error as GithubErrorCode, details);
  }

  return {
    async get() {
      const who = await admin();
      if (who instanceof Response) return who;
      const view = await guarded(() => service.view());
      if (view instanceof Response) return view;
      return Response.json(view, { headers: NO_STORE });
    },

    async put(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      if (isCrossSite(request)) return refusal("cross_site_request");
      const body = await readBody(request);
      if (!body.ok) return refusal(body.error);
      const value = body.value;
      const given =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? SETTING_KEYS.filter((key) => Object.hasOwn(value, key))
          : [];
      if (given.length !== 1 || Object.keys(value as object).length !== 1)
        return refusal("invalid_input", {
          issues: [{ field: "", code: "body_invalid" }],
        });
      const fields = value as Record<string, unknown>;
      const result = await guarded(async () => {
        switch (given[0]) {
          case "app":
            return service.saveApp(who.id, fields.app);
          case "userAuthorization":
            return service.saveUserAuthorization(
              who.id,
              fields.userAuthorization,
            );
          default:
            return service.setPrivateApp(who.id, fields.privateApp);
        }
      });
      if (result instanceof Response) return result;
      if (!result.ok) return fromServiceFailure(result);
      const view = await guarded(() => service.view());
      if (view instanceof Response) return view;
      return Response.json({ ok: true, github: view }, { headers: NO_STORE });
    },

    async startManifest(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      if (isCrossSite(request)) return refusal("cross_site_request");
      const session = await sessionId();
      if (session === null) return refusal("session_required");
      const body = await readBody(request, true);
      if (!body.ok) return refusal(body.error);
      const result = await guarded(() =>
        service.startManifest({ id: who.id, sessionId: session }, body.value),
      );
      if (result instanceof Response) return result;
      if (!result.ok) return fromServiceFailure(result);
      return Response.json(
        { ok: true, postUrl: result.postUrl, manifest: result.manifest },
        { headers: NO_STORE },
      );
    },

    async manifestCallback(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      const session = await sessionId();
      if (session === null) return refusal("session_required");
      const url = new URL(request.url);
      const result = await guarded(() =>
        service.completeManifest(
          { id: who.id, sessionId: session },
          {
            code: url.searchParams.get("code"),
            state: url.searchParams.get("state"),
          },
        ),
      );
      if (result instanceof Response) return result;
      // The person is sent on to a fixed page with the outcome: only a code from our own list ever
      // appears in the address, nothing GitHub or the request said.
      const query = result.ok
        ? "github=created"
        : `github_error=${COMPLETE_MANIFEST_ERROR_CODES.includes(result.error) ? result.error : "unknown"}`;
      return new Response(null, {
        status: 302,
        headers: {
          location: `${GITHUB_APP_PAGE}?${query}`,
          "referrer-policy": "no-referrer",
          ...NO_STORE,
        },
      });
    },

    async startLink(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      // A JSON object from this site, like every other POST of the portal (the shared reader).
      const body = await readJsonObject(request, GITHUB_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const session = await sessionId();
      if (session === null) return refusal("session_required");
      if (link === undefined) return refusal("unavailable");
      const result = await guarded(() =>
        link.start({ id: who.id, sessionId: session }, { surface: "admin" }),
      );
      if (result instanceof Response) return result;
      if (!result.ok) return fromServiceFailure(result);
      return Response.json(
        { ok: true, url: result.url },
        { headers: NO_STORE },
      );
    },

    async check(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      const body = await readJsonObject(request, GITHUB_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await guarded(() => service.checkPermissions(who.id));
      if (result instanceof Response) return result;
      if (!result.ok) return fromServiceFailure(result);
      return Response.json(
        { ok: true, missing: result.missing },
        { headers: NO_STORE },
      );
    },
  };
}
