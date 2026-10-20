// SPDX-License-Identifier: Apache-2.0

// The handlers behind the data routes for catalog prices and enablement in the admin portal (#549), with their
// collaborators passed in so the route files only wire the real ones and tests wire fakes. Paths as the admin sees them
// (the proxy rewrites `/api/admin/...` to the files below `/api/instance-portal/...`):
//
//   GET  /api/admin/catalog-models                every model of the models.dev catalog with its price status and sources,
//                                                 the "new" flag, the admin's decisions and whether the managed key may use
//                                                 it; query: provider, search, priceStatus, enabled (yes|no|undecided), new
//                                                 (true), limit, offset. Also the "new" count and the state of the last fetch.
//   POST /api/admin/catalog-models/enablement     { providerId, modelId, enabled }: enable or disable a model for the managed key
//   POST /api/admin/catalog-models/enablement/reset  { providerId, modelId }: take the decision back, so the model is "new" again
//   POST /api/admin/catalog-models/price/confirm  { providerId, modelId, referenceHash }: confirm the price as the admin saw it
//   POST /api/admin/catalog-models/price/correct  { providerId, modelId, referenceHash, price, reason }: state the price
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in but not an admin is a
// 404 like for any path that does not exist), then for a change where the request comes from, its content type and its body
// (an object, at most 64 KB), then the service. Every refusal is `{ "error": <code>, "issues"?: [{ field, code }] }` with a
// stable code from admin-errors.ts, every answer is `Cache-Control: no-store`. Nothing is reachable by a member of a
// workspace or by the operator API (decision C8): prices and provider names are the operator's alone (Epic #489).
import "server-only";
import type { AdminAccess } from "../admin/access.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { readJsonObject } from "../http/json-body.ts";
import {
  MODEL_PRICE_ROUTE_ERROR_STATUS,
  type ModelPriceRouteErrorCode,
} from "./admin-errors.ts";
import { PRICE_STATUSES } from "./effective-price.ts";
import {
  ENABLED_FILTERS,
  MAX_PAGE_SIZE,
  type ListQuery,
  type ModelChange,
  type ModelPriceService,
} from "./service.ts";

/** A few short fields: the biggest body is a price book of eight tiers, well below this. */
export const MODEL_PRICE_REQUEST_MAX_BYTES = 64 * 1024;

export type ModelPriceRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin: Next.js's own, so it is the one of a path that does not exist. Throws. */
  notFound: () => never;
  service: ModelPriceService;
};

export type ModelPriceRouteHandlers = {
  list(request: Request): Promise<Response>;
  setEnabled(request: Request): Promise<Response>;
  resetDecision(request: Request): Promise<Response>;
  confirmPrice(request: Request): Promise<Response>;
  correctPrice(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(code: ModelPriceRouteErrorCode, field?: string): Response {
  return Response.json(
    {
      error: code,
      ...(field === undefined ? {} : { issues: [{ field, code }] }),
    },
    { status: MODEL_PRICE_ROUTE_ERROR_STATUS[code], headers: NO_STORE },
  );
}

type QueryParse = { ok: true; query: ListQuery } | { ok: false; field: string };

function wholeNumber(text: string, max: number): number | undefined {
  return /^\d{1,9}$/.test(text) && Number(text) <= max
    ? Number(text)
    : undefined;
}

/** The list query of a URL; a value that is not one of the documented is refused with its name, never ignored. */
export function parseListQuery(url: URL): QueryParse {
  const query: ListQuery = {};
  for (const [name, value] of url.searchParams) {
    if (name === "provider" && value !== "" && value.length <= 200)
      query.provider = value;
    else if (name === "search" && value.length <= 200) query.search = value;
    else if (name === "priceStatus") {
      const status = PRICE_STATUSES.find((candidate) => candidate === value);
      if (status === undefined) return { ok: false, field: name };
      query.priceStatus = status;
    } else if (name === "enabled") {
      const enabled = ENABLED_FILTERS.find((candidate) => candidate === value);
      if (enabled === undefined) return { ok: false, field: name };
      query.enabled = enabled;
    } else if (name === "new" && value === "true") query.onlyNew = true;
    else if (name === "limit" || name === "offset") {
      const number = wholeNumber(
        value,
        name === "limit" ? MAX_PAGE_SIZE : 1_000_000,
      );
      if (number === undefined) return { ok: false, field: name };
      query[name] = number;
    } else return { ok: false, field: name };
  }
  return { ok: true, query };
}

export function createModelPriceRouteHandlers({
  access,
  notFound,
  service,
}: ModelPriceRouteDependencies): ModelPriceRouteHandlers {
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
      // No error text: it could carry whatever the failing layer held (a model id, a price).
      console.error(
        "[model-prices] MODEL_PRICES_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable");
    }
  }

  function answer(result: ModelChange): Response {
    if (!result.ok) return refusal(result.code, result.field);
    return Response.json(result, { headers: NO_STORE });
  }

  /** The admin, then the request's origin, type and body, then the call. */
  async function change(
    request: Request,
    run: (
      who: SessionUser,
      body: Record<string, unknown>,
    ) => Promise<ModelChange>,
  ): Promise<Response> {
    const who = await admin();
    if (who instanceof Response) return who;
    const body = await readJsonObject(request, MODEL_PRICE_REQUEST_MAX_BYTES);
    if (!body.ok) return refusal(body.error);
    const result = await guarded(() => run(who, body.value));
    return result instanceof Response ? result : answer(result);
  }

  return {
    async list(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      const parsed = parseListQuery(new URL(request.url));
      if (!parsed.ok) return refusal("request_invalid", parsed.field);
      const list = await guarded(() => service.list(parsed.query));
      if (list instanceof Response) return list;
      return Response.json(list, { headers: NO_STORE });
    },

    setEnabled: (request) =>
      change(request, (who, body) => service.setEnabled(who.id, body)),
    resetDecision: (request) =>
      change(request, (who, body) => service.resetDecision(who.id, body)),
    confirmPrice: (request) =>
      change(request, (who, body) => service.confirmPrice(who.id, body)),
    correctPrice: (request) =>
      change(request, (who, body) => service.correctPrice(who.id, body)),
  };
}
