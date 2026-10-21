// SPDX-License-Identifier: Apache-2.0

// The handlers behind the billing data routes of the admin portal (#504), with their collaborators passed in so the route
// files only wire the real ones and tests wire the fake Stripe:
//
//   GET  /api/admin/billing                                  the settings as the page shows them (never a secret)
//   PUT  /api/admin/billing                                  one change; the body has exactly one of
//                                                            { "adapter": "manual" | "stripe" }
//                                                            { "stripe": { "apiKey"?, "webhookSecret"? } }  (write-only: an
//                                                              empty one keeps the stored one)
//                                                            { "removeSecret": "apiKey" | "webhookSecret" }
//                                                            { "rates": { factorA, minuteRateMicroUsd, ... } }  (integers)
//                                                            { "enabled": boolean }   (switching on checks everything)
//   POST /api/admin/billing/check                            a harmless call to Stripe with the stored key; answers
//                                                            { "ok": true, "environment" } or { "ok": false, "error": <code> }
//   POST /api/admin/billing/webhook-endpoint                 makes sure the endpoint exists at Stripe and its secret is
//                                                            stored (creates it, or adopts the one for this app's address);
//                                                            { "recreate": true } replaces both
//   GET  /api/admin/billing/workspaces?q=                    workspaces by name, for the manual credit
//   GET  /api/admin/billing/workspaces/<id>                  a workspace's balance and its recent entries
//   POST /api/admin/billing/workspaces/<id>/credit           { "type": "credit" | "correction", "amountMicroUsd", "note",
//                                                            "requestId" }   (required: it makes a retry one entry)
//
// These routes configure billing, so they work while billing is off: only the instance admin reaches them. The routes of
// billing itself (the webhook, checkout) answer the 404 of a missing path while it is off (`enabled.ts`).
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in but not an admin is a 404
// like for any path that does not exist), then for a change where the request comes from, its content type and its body, then
// the service. Every refusal is `{ "error": <code> }` with a stable code from admin-errors.ts, every answer is
// `Cache-Control: no-store`.
import "server-only";
import type { AdminAccess } from "../admin/access.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { readJsonObject } from "../http/json-body.ts";
import { BILLING_ERROR_STATUS, type BillingErrorCode } from "./admin-errors.ts";
import type {
  BillingCreditService,
  CreditFailure,
} from "./admin-credit-service.ts";
import type { BillingAdminService, BillingFailure } from "./admin-service.ts";

/** A few short fields: the biggest body is well below this. */
export const BILLING_REQUEST_MAX_BYTES = 16 * 1024;
/** The longest search text; a workspace name is shorter than this. */
export const WORKSPACE_SEARCH_MAX_LENGTH = 100;

export type BillingRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin: Next.js's own. Throws. */
  notFound: () => never;
  service: BillingAdminService;
  credit: BillingCreditService;
};

export type BillingRouteHandlers = {
  get(request: Request): Promise<Response>;
  put(request: Request): Promise<Response>;
  check(request: Request): Promise<Response>;
  webhookEndpoint(request: Request): Promise<Response>;
  searchWorkspaces(request: Request): Promise<Response>;
  workspace(request: Request, workspaceId: string): Promise<Response>;
  credit(request: Request, workspaceId: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };
const CHANGE_KEYS = [
  "adapter",
  "stripe",
  "removeSecret",
  "rates",
  "enabled",
] as const;

function refusal(
  code: BillingErrorCode,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: code, ...extra },
    { status: BILLING_ERROR_STATUS[code], headers: NO_STORE },
  );
}

function fromFailure(result: BillingFailure | CreditFailure): Response {
  const { error, ...details } = result;
  delete (details as { ok?: boolean }).ok;
  return refusal(error, details);
}

export function createBillingRouteHandlers({
  access,
  notFound,
  service,
  credit,
}: BillingRouteDependencies): BillingRouteHandlers {
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

  /** Runs a service call; a database or a Stripe answer that breaks the rules is a 503, never a pass and never a message. */
  async function guarded<T>(work: () => Promise<T>): Promise<T | Response> {
    try {
      return await work();
    } catch {
      // No error text: it could carry whatever the failing layer held.
      console.error(
        "[billing] BILLING_ADMIN_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable");
    }
  }

  async function answerWithView(): Promise<Response> {
    const view = await guarded(() => service.view());
    if (view instanceof Response) return view;
    return Response.json({ ok: true, billing: view }, { headers: NO_STORE });
  }

  /** The admin, then the checked JSON body. */
  async function adminWithBody(
    request: Request,
  ): Promise<{ who: SessionUser; body: Record<string, unknown> } | Response> {
    const who = await admin();
    if (who instanceof Response) return who;
    const body = await readJsonObject(request, BILLING_REQUEST_MAX_BYTES);
    if (!body.ok) return refusal(body.error);
    return { who, body: body.value };
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
      const read = await adminWithBody(request);
      if (read instanceof Response) return read;
      const { who, body: fields } = read;
      const given = CHANGE_KEYS.filter((key) => Object.hasOwn(fields, key));
      if (given.length !== 1 || Object.keys(fields).length !== 1)
        return refusal("invalid_input", {
          issues: [{ field: "", code: "body_invalid" }],
        });
      const result = await guarded(() => {
        switch (given[0]) {
          case "adapter":
            return service.chooseAdapter(who.id, fields.adapter);
          case "stripe":
            return service.saveCredentials(who.id, fields.stripe);
          case "removeSecret":
            return service.removeSecret(who.id, fields.removeSecret);
          case "rates":
            return service.saveRates(who.id, fields.rates);
          default:
            return service.setEnabled(who.id, fields.enabled);
        }
      });
      if (result instanceof Response) return result;
      if (!result.ok) return fromFailure(result);
      return answerWithView();
    },

    async check(request) {
      const read = await adminWithBody(request);
      if (read instanceof Response) return read;
      const result = await guarded(() => service.checkConnection(read.who.id));
      if (result instanceof Response) return result;
      // What Stripe said is the result of the check, not an error of this route.
      return Response.json(result, { headers: NO_STORE });
    },

    async webhookEndpoint(request) {
      const read = await adminWithBody(request);
      if (read instanceof Response) return read;
      const { recreate } = read.body;
      if (
        Object.keys(read.body).some((key) => key !== "recreate") ||
        (recreate !== undefined && typeof recreate !== "boolean")
      )
        return refusal("invalid_input", {
          issues: [{ field: "", code: "body_invalid" }],
        });
      const result = await guarded(() =>
        service.createWebhookEndpoint(read.who.id, {
          recreate: recreate === true,
        }),
      );
      if (result instanceof Response) return result;
      if (!result.ok) return fromFailure(result);
      const view = await guarded(() => service.view());
      if (view instanceof Response) return view;
      return Response.json(
        { ok: true, created: result.created, billing: view },
        { headers: NO_STORE },
      );
    },

    async searchWorkspaces(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      const text = new URL(request.url).searchParams.get("q") ?? "";
      if (text.length > WORKSPACE_SEARCH_MAX_LENGTH)
        return refusal("invalid_input", {
          issues: [{ field: "q", code: "body_invalid" }],
        });
      const workspaces = await guarded(() => credit.search(text));
      if (workspaces instanceof Response) return workspaces;
      return Response.json({ workspaces }, { headers: NO_STORE });
    },

    async workspace(_request, workspaceId) {
      const who = await admin();
      if (who instanceof Response) return who;
      const found = await guarded(() => credit.workspace(workspaceId));
      if (found instanceof Response) return found;
      if (found === undefined) return refusal("workspace_not_found");
      return Response.json(found, { headers: NO_STORE });
    },

    async credit(request, workspaceId) {
      const read = await adminWithBody(request);
      if (read instanceof Response) return read;
      const result = await guarded(() =>
        credit.credit(read.who.id, workspaceId, read.body),
      );
      if (result instanceof Response) return result;
      if (!result.ok) return fromFailure(result);
      const found = await guarded(() => credit.workspace(workspaceId));
      if (found instanceof Response) return found;
      return Response.json(
        { ok: true, workspace: found },
        { headers: NO_STORE },
      );
    },
  };
}
