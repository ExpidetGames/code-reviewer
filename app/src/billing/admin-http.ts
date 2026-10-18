// SPDX-License-Identifier: Apache-2.0

// The handlers behind the billing data routes of the admin portal (#437), with their collaborators passed in so the
// route files only wire the real ones and tests wire the fake Paddle:
//
//   GET  /api/admin/billing                              the settings as the page shows them (never a secret)
//   PUT  /api/admin/billing                              one change; the body has exactly one of
//                                                        { "settings": { environment, clientToken, graceDays,
//                                                          apiKey, webhookSecret } }   (the two secrets are write-only:
//                                                          an empty one keeps the stored one)
//                                                        { "removeSecret": "apiKey" | "webhookSecret" }
//                                                        { "enabled": boolean }   (switching on checks everything)
//   POST /api/admin/billing/check                        a harmless call to Paddle with the stored key; answers
//                                                        { "ok": true } or { "ok": false, "error": <code> }
//   POST /api/admin/billing/notification-destination     makes sure the destination exists at Paddle (creates it, or
//                                                        adopts the one for this app's address) and its secret is
//                                                        stored; { "recreate": true } replaces both
//
// These routes configure billing, so they work while billing is off: only the instance admin reaches them. The
// routes of billing itself (the webhook, checkout) answer the 404 of a missing path while it is off (`enabled.ts`).
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in but not an
// admin is a 404 like for any path that does not exist), then for a change where the request comes from, its content
// type and its body, then the service. Every refusal is `{ "error": <code> }` with a stable code from
// admin-errors.ts, every answer is `Cache-Control: no-store`.
import "server-only";
import type { AdminAccess } from "../admin/access.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { readJsonObject } from "../http/json-body.ts";
import { BILLING_ERROR_STATUS, type BillingErrorCode } from "./admin-errors.ts";
import type {
  BillingFailure,
  BillingSettingsService,
} from "./settings-service.ts";

/** A few short fields: the biggest body is well below this. */
export const BILLING_REQUEST_MAX_BYTES = 16 * 1024;

export type BillingRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin: Next.js's own. Throws. */
  notFound: () => never;
  service: BillingSettingsService;
};

export type BillingRouteHandlers = {
  get(request: Request): Promise<Response>;
  put(request: Request): Promise<Response>;
  check(request: Request): Promise<Response>;
  createNotificationDestination(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };
const SETTING_KEYS = ["settings", "removeSecret", "enabled"] as const;

function refusal(
  code: BillingErrorCode,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: code, ...extra },
    { status: BILLING_ERROR_STATUS[code], headers: NO_STORE },
  );
}

function fromFailure(result: BillingFailure): Response {
  const { error, ...details } = result;
  delete (details as { ok?: boolean }).ok;
  return refusal(error, details);
}

export function createBillingRouteHandlers({
  access,
  notFound,
  service,
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

  /** Runs a service call; a database or a Paddle answer that breaks the rules is a 503, never a pass and never a message. */
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
      const body = await readJsonObject(request, BILLING_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const fields = body.value;
      const given = SETTING_KEYS.filter((key) => Object.hasOwn(fields, key));
      if (given.length !== 1 || Object.keys(fields).length !== 1)
        return refusal("invalid_input", {
          issues: [{ field: "", code: "body_invalid" }],
        });
      const result = await guarded(() => {
        switch (given[0]) {
          case "settings":
            return service.saveSettings(who.id, fields.settings);
          case "removeSecret":
            return service.removeSecret(who.id, fields.removeSecret);
          default:
            return service.setEnabled(who.id, fields.enabled);
        }
      });
      if (result instanceof Response) return result;
      if (!result.ok) return fromFailure(result);
      return answerWithView();
    },

    async check(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      const body = await readJsonObject(request, BILLING_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const result = await guarded(() => service.checkConnection());
      if (result instanceof Response) return result;
      // What Paddle said is the result of the check, not an error of this route.
      return Response.json(result, { headers: NO_STORE });
    },

    async createNotificationDestination(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      const body = await readJsonObject(request, BILLING_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const keys = Object.keys(body.value);
      const { recreate } = body.value;
      if (
        keys.some((key) => key !== "recreate") ||
        (recreate !== undefined && typeof recreate !== "boolean")
      )
        return refusal("invalid_input", {
          issues: [{ field: "", code: "body_invalid" }],
        });
      const result = await guarded(() =>
        service.createNotificationDestination(who.id, {
          recreate: recreate === true,
        }),
      );
      if (result instanceof Response) return result;
      if (!result.ok) return fromFailure(result);
      return answerWithView();
    },
  };
}
