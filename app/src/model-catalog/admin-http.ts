// SPDX-License-Identifier: Apache-2.0

// The handlers behind the catalog data routes of the admin portal (#429), with their collaborators passed in so the route
// files only wire the real ones and tests wire fakes:
//
//   GET    /api/admin/model-catalog               every entry (the operator's view, a retired one too, with the number of
//                                                 projects that use it), the two instance defaults and the providers
//   POST   /api/admin/model-catalog               a new entry, as a draft: { name, description, provider, modelId, kinds }
//   PUT    /api/admin/model-catalog/:id           changes the given fields; the model or provider behind a released entry
//                                                 changes only with "confirmModelChange": true, else 409
//                                                 `model_change_not_confirmed` with the number of `projects` that use it
//   DELETE /api/admin/model-catalog/:id           deletes a draft
//   POST   /api/admin/model-catalog/:id/release   draft or retired to released, after the provider's metadata vouches for it
//   POST   /api/admin/model-catalog/:id/retire    released to retired (not while it is a default)
//   PUT    /api/admin/model-catalog/defaults      { diff: <id> | null, dynamic: <id> | null }
//   PUT    /api/admin/model-catalog/order         { order: [<id>, ...] }: every entry once, first to last, in one transaction;
//                                                 a list that is not exactly the entries is 409 `catalog_conflict`
//   POST   /api/admin/model-catalog/check         { provider, modelId, kinds }: "Check model" without storing anything;
//                                                 answers { ok: true, verified } or { ok: false, error: <code> }
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in but not an admin is
// a 404 like for any path that does not exist), then for a change where the request comes from, its content type and its
// body (an object, at most 64 KB), then the service. Every refusal is `{ "error": <code>, "issues"?: [{ field, code }] }`
// with a stable code from admin-errors.ts, every answer is `Cache-Control: no-store`. Nothing is reachable by a member of a
// workspace or by the operator API (decision C8).
import "server-only";
import type { AdminAccess } from "../admin/access.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { readJsonObject } from "../http/json-body.ts";
import {
  CATALOG_ROUTE_ERROR_STATUS,
  type CatalogRouteErrorCode,
} from "./admin-errors.ts";
import type { AdminFailure, CatalogAdminService } from "./admin-service.ts";

/** A few short fields: the biggest body is well below this. */
export const CATALOG_REQUEST_MAX_BYTES = 64 * 1024;

export type CatalogRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin: Next.js's own, so it is the one of a path that does not exist. Throws. */
  notFound: () => never;
  service: CatalogAdminService;
};

export type CatalogRouteHandlers = {
  get(request: Request): Promise<Response>;
  create(request: Request): Promise<Response>;
  update(request: Request, id: string): Promise<Response>;
  remove(request: Request, id: string): Promise<Response>;
  reorder(request: Request): Promise<Response>;
  release(request: Request, id: string): Promise<Response>;
  retire(request: Request, id: string): Promise<Response>;
  setDefaults(request: Request): Promise<Response>;
  check(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: CatalogRouteErrorCode,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: code, ...extra },
    { status: CATALOG_ROUTE_ERROR_STATUS[code], headers: NO_STORE },
  );
}

function fromFailure(result: AdminFailure): Response {
  if (result.code === "model_change_not_confirmed")
    return refusal(result.code, { projects: result.projects });
  return refusal(
    result.code,
    result.field === undefined
      ? {}
      : { issues: [{ field: result.field, code: result.code }] },
  );
}

export function createCatalogRouteHandlers({
  access,
  notFound,
  service,
}: CatalogRouteDependencies): CatalogRouteHandlers {
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

  /** Runs a service call; a database or a provider answer that breaks the rules is a 503, never a pass and never a message. */
  async function guarded<T>(work: () => Promise<T>): Promise<T | Response> {
    try {
      return await work();
    } catch {
      // No error text: it could carry whatever the failing layer held (an address, a model id).
      console.error(
        "[model-catalog] CATALOG_ADMIN_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable");
    }
  }

  /** The admin, then the request's origin, type and body (every change sends a JSON object, `{}` for one with nothing to say). */
  async function change(
    request: Request,
    run: (who: SessionUser, body: Record<string, unknown>) => Promise<Response>,
  ): Promise<Response> {
    const who = await admin();
    if (who instanceof Response) return who;
    const body = await readJsonObject(request, CATALOG_REQUEST_MAX_BYTES);
    if (!body.ok) return refusal(body.error);
    return guarded(() => run(who, body.value));
  }

  function answer(result: Awaited<ReturnType<CatalogAdminService["create"]>>) {
    if (!result.ok) return fromFailure(result);
    return Response.json(result, { headers: NO_STORE });
  }

  return {
    async get() {
      const who = await admin();
      if (who instanceof Response) return who;
      const view = await guarded(() => service.view());
      if (view instanceof Response) return view;
      return Response.json(view, { headers: NO_STORE });
    },

    create: (request) =>
      change(request, async (who, body) =>
        answer(await service.create(who.id, body)),
      ),

    update: (request, id) =>
      change(request, async (who, body) =>
        answer(await service.update(who.id, id, body)),
      ),

    remove: (request, id) =>
      change(request, async () => answer(await service.remove(id))),

    release: (request, id) =>
      change(request, async (who) => answer(await service.release(who.id, id))),

    retire: (request, id) =>
      change(request, async (who) => answer(await service.retire(who.id, id))),

    reorder: (request) =>
      change(request, async (who, body) =>
        answer(await service.reorder(who.id, body)),
      ),

    setDefaults: (request) =>
      change(request, async (who, body) =>
        answer(await service.setDefaults(who.id, body)),
      ),

    check: (request) =>
      change(request, async (_who, body) => {
        const result = await service.check(body);
        if (result.ok) return Response.json(result, { headers: NO_STORE });
        // What the provider's metadata said about the model is the result of the check; a request that is not a model
        // to check is a refusal like any other.
        if (result.field !== undefined || result.code === "request_invalid")
          return fromFailure(result);
        return Response.json(
          { ok: false, error: result.code },
          { headers: NO_STORE },
        );
      }),
  };
}
