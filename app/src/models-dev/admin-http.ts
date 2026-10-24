// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the data routes for the models.dev catalog in the admin portal (#554), with their collaborators
// passed in so the route files only wire the real ones and tests wire fakes. Paths as the admin sees them (the proxy
// rewrites `/api/admin/...` to the files below `/api/instance-portal/...`):
//
//   POST /api/admin/catalog-providers/url/confirm  { providerId, pendingUrl }: trust the address the admin saw
//   POST /api/admin/catalog-fetch                  {} or { acceptReasons: [guard code, ...] }: fetch the catalog now
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in but not an admin
// is a 404 like for any path that does not exist), then for a change where the request comes from, its content type and
// its body (an object, at most 4 KB), then the service. Every refusal is `{ "error": <code> }` with a stable code from
// admin-errors.ts (`fetch_rate_limited` adds `retryAfterSeconds`; a fetch the guard stopped, 409, adds `reasons`, the code
// of every reason that tripped, and `details`, the figures it measured), every answer is `Cache-Control: no-store`. Nothing is
// reachable by a member of a workspace or by the operator API: provider addresses are the operator's alone.
import "server-only";
import type { AdminAccess } from "../admin/access.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { readJsonObject } from "../http/json-body.ts";
import {
  MODELS_DEV_ADMIN_ERROR_STATUS,
  type ModelsDevAdminErrorCode,
} from "./admin-errors.ts";
import type { ModelsDevAdminService } from "./admin-service.ts";

/** Two short fields at most. */
export const MODELS_DEV_REQUEST_MAX_BYTES = 4 * 1024;

export type ModelsDevRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin: Next.js's own, so it is the one of a path that does not exist. Throws. */
  notFound: () => never;
  service: ModelsDevAdminService;
};

export type ModelsDevRouteHandlers = {
  confirmUrl(request: Request): Promise<Response>;
  fetchNow(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: ModelsDevAdminErrorCode,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: code, ...extra },
    { status: MODELS_DEV_ADMIN_ERROR_STATUS[code], headers: NO_STORE },
  );
}

export function createModelsDevRouteHandlers({
  access,
  notFound,
  service,
}: ModelsDevRouteDependencies): ModelsDevRouteHandlers {
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

  /** Runs a service call; a database answer that breaks the rules is a 503, never a pass and never a message. */
  async function guarded<T>(work: () => Promise<T>): Promise<T | Response> {
    try {
      return await work();
    } catch {
      // No error text: it could carry whatever the failing layer held (an address, a connection string).
      console.error(
        "[models-dev] MODELS_DEV_ADMIN_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable");
    }
  }

  /** The admin, then the request's origin, type and body, then the call. */
  async function change(
    request: Request,
    run: (who: SessionUser, body: Record<string, unknown>) => Promise<Response>,
  ): Promise<Response> {
    const who = await admin();
    if (who instanceof Response) return who;
    const body = await readJsonObject(request, MODELS_DEV_REQUEST_MAX_BYTES);
    if (!body.ok) return refusal(body.error);
    return guarded(() => run(who, body.value));
  }

  return {
    confirmUrl: (request) =>
      change(request, async (who, body) => {
        const result = await service.confirmUrl(who.id, body);
        return result.ok
          ? Response.json(result, { headers: NO_STORE })
          : refusal(result.code);
      }),

    fetchNow: (request) =>
      change(request, async (who, body) => {
        const result = await service.fetchNow(who.id, body);
        if (result.ok) return Response.json(result, { headers: NO_STORE });
        return refusal(result.code, {
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
          ...(result.guard === undefined
            ? {}
            : { reasons: result.guard.reasons, details: result.guard.details }),
        });
      }),
  };
}
