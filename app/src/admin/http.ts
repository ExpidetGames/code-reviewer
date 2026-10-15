// SPDX-License-Identifier: Apache-2.0

// The handlers behind the admin data routes, with their collaborators passed in so the route files only
// wire the real ones and tests wire fakes:
//
//   GET /api/admin/settings   every instance setting with who saved it and when, the status of the
//                             secrets (never a value) and the facts the overview shows
//   PUT /api/admin/settings   changes one setting; the body has exactly one of
//                             { "tenancy": "single" | "multi" }
//                             { "signUp": { "kind": "everyone" | "emails" | "domains", "entries": [...] } }
//                             { "signInMethods": { "emailPassword": boolean, "github": boolean } }
//                             { "limits": { "maxWorkspacesPerUser": number } }
//                             { "dynamicReview": { "enabled": boolean } }   the Dynamic Review rollout gate
//                             (contracts/README.md: off cancels the waiting Dynamic jobs, running ones finish)
//                             { "smtp": { host, port, security, user, password, clearPassword,
//                                         senderAddress, senderName, allowSelfSigned } | null }
//                             (the password is write-only: an empty one keeps the stored one, and no
//                             answer ever contains it; null removes the mail server)
//                             { "operatorLlmKey": { "apiKey": "..." } | null }   the operator's own LLM key, used by
//                             the workspaces whose key mode is `managed` (#276; src/llm/operator-key.ts). Write-only:
//                             the answers carry its status and the last four characters, never the key; null
//                             removes it. Only an instance admin gets here, and the operator API has no such call
//                             { "importNotice": { "dismiss": true } }   hides the notice that the import of an
//                             existing installation left (src/legacy-import/)
//   POST /api/admin/mail/test sends a test mail to the admin's own address with the saved settings;
//                             answers { "ok": true } or { "ok": false, "error": <class>, "detail" }
//   POST /api/admin/integrations/sync  reads the installations and repositories from GitHub now (every
//                             connection of the instance, which is why it is not a workspace route);
//                             answers { "added": number, "errors": [...] } (src/integrations/sync/http.ts)
//
// Order: the admin first (nothing is read before the caller is known: not signed in is 401, signed in
// but not an admin is a 404 like for any path that does not exist), then for a change where the
// request comes from, its content type and its body, then the service. Every refusal is
// `{ "error": <code> }` with a stable code from errors.ts, every answer is `Cache-Control: no-store`.
import type { SessionUser } from "../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { createSyncRouteHandler } from "../integrations/sync/http.ts";
import type { IntegrationSyncService } from "../integrations/sync/service.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import type { AdminAccess } from "./access.ts";
import { ADMIN_ERROR_STATUS, type AdminErrorCode } from "./errors.ts";
import type { AdminService } from "./service.ts";

/** A signup rule has at most 500 entries of up to 254 characters. */
export const ADMIN_REQUEST_MAX_BYTES = 256 * 1024;

export type AdminRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin: Next.js's own, so it is the one of a path that does not exist. Throws. */
  notFound: () => never;
  service: AdminService;
  /**
   * The process-wide synchronization with GitHub (the one the start-up sync and the webhooks use), asked for
   * only when an admin's request for it is served.
   */
  sync: () => Pick<IntegrationSyncService, "syncAll">;
};

export type AdminRouteHandlers = {
  getSettings(request: Request): Promise<Response>;
  putSettings(request: Request): Promise<Response>;
  testMail(request: Request): Promise<Response>;
  syncIntegrations(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: AdminErrorCode,
  extra: Record<string, unknown> = {},
  retryAfterSeconds?: number,
): Response {
  return Response.json(
    { error: code, ...extra },
    {
      status: ADMIN_ERROR_STATUS[code],
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
): Promise<
  { ok: true; value: unknown } | { ok: false; error: AdminErrorCode }
> {
  if (!isJsonRequest(request))
    return { ok: false, error: "unsupported_content_type" };
  const body = await readLimitedBody(request, ADMIN_REQUEST_MAX_BYTES);
  if (!body.ok) return { ok: false, error: "body_too_large" };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: true, value: undefined };
  }
}

const SETTING_KEYS = [
  "tenancy",
  "signUp",
  "signInMethods",
  "limits",
  "dynamicReview",
  "smtp",
  "operatorLlmKey",
  "importNotice",
] as const;

export function createAdminRouteHandlers({
  access,
  notFound,
  service,
  sync,
}: AdminRouteDependencies): AdminRouteHandlers {
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

  return {
    async getSettings() {
      const who = await admin();
      if (who instanceof Response) return who;
      return Response.json(await service.readSettings(), { headers: NO_STORE });
    },

    async putSettings(request) {
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
      const setting = given[0];
      const fields = value as Record<string, unknown>;

      const result = await (async () => {
        switch (setting) {
          case "tenancy": {
            const tenancy = fields.tenancy;
            if (tenancy !== "single" && tenancy !== "multi")
              return {
                ok: false,
                error: "invalid_input",
                issues: [{ field: "tenancy", code: "tenancy_invalid" }],
              } as const;
            return service.changeTenancy(who.id, tenancy);
          }
          case "signUp":
            return service.changeSignUpRule(who.id, fields.signUp);
          case "signInMethods":
            return service.changeSignInMethods(who.id, fields.signInMethods);
          case "dynamicReview":
            return service.changeDynamicReview(who.id, fields.dynamicReview);
          case "smtp":
            return service.changeSmtp(who.id, fields.smtp);
          case "operatorLlmKey":
            return service.changeOperatorLlmKey(who.id, fields.operatorLlmKey);
          case "importNotice": {
            const change = fields.importNotice;
            if (
              typeof change !== "object" ||
              change === null ||
              (change as Record<string, unknown>).dismiss !== true
            )
              return {
                ok: false,
                error: "invalid_input",
                issues: [{ field: "importNotice", code: "body_invalid" }],
              } as const;
            return service.dismissImportNotice(who.id);
          }
          default: {
            const limits = fields.limits;
            if (
              typeof limits !== "object" ||
              limits === null ||
              Array.isArray(limits)
            )
              return {
                ok: false,
                error: "invalid_input",
                issues: [{ field: "limits", code: "limits_invalid" }],
              } as const;
            return service.changeLimits(who.id, {
              maxWorkspacesPerUser: (limits as Record<string, unknown>)
                .maxWorkspacesPerUser,
            });
          }
        }
      })();

      if (!result.ok) {
        // The code and what belongs to it (the issues, the number of workspaces); not the `ok` flag.
        const details: Record<string, unknown> = { ...result };
        delete details.ok;
        delete details.error;
        return refusal(result.error, details);
      }
      return Response.json(
        { ok: true, settings: await service.readSettings() },
        { headers: NO_STORE },
      );
    },

    async testMail(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      if (isCrossSite(request)) return refusal("cross_site_request");
      const body = await readBody(request);
      if (!body.ok) return refusal(body.error);

      let result: Awaited<ReturnType<AdminService["sendTestMail"]>>;
      try {
        result = await service.sendTestMail({ id: who.id, email: who.email });
      } catch {
        // The counters (or the database) could not be read: no mail is sent without a limit.
        console.error(
          "[admin] TEST_MAIL_UNAVAILABLE: the request was not served.",
        );
        return refusal("unavailable");
      }
      if (result.ok) return Response.json({ ok: true }, { headers: NO_STORE });
      if (result.error === "rate_limited")
        return refusal("rate_limited", {}, result.retryAfterSeconds);
      // The mail server's answer is the result of the check, not an error of this route.
      return Response.json(
        { ok: false, error: result.error, detail: result.detail },
        { headers: NO_STORE },
      );
    },

    async syncIntegrations(request) {
      const who = await admin();
      if (who instanceof Response) return who;
      return createSyncRouteHandler({
        requireUser: () => Promise.resolve(who),
        sync: sync(),
      })(request);
    },
  };
}
