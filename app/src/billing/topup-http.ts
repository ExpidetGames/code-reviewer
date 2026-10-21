// SPDX-License-Identifier: Apache-2.0

// The handler behind `POST /api/w/:workspace/billing/top-ups` (ADR 0006, 2.13; #501), with its collaborators passed in so the
// route file only wires the real ones in (`shared.ts`) and tests wire the real services over a test database. The order is the
// contract; each step ends the request on failure:
//
//   1. billing      off: the 404 of a path that does not exist, before anything else is read or asked
//   2. adapter      none, or one with no checkout page (`manual`): the same 404
//   3. same site    `Sec-Fetch-Site` / `Origin` (src/http/request-checks.ts)                      403 cross_site_request
//   4. access       the session and the role (`manage_billing`: an Admin or an Owner)    401 / 404 / 403, access-response.ts
//   5. limit        per person and workspace                                                      429 rate_limited
//   6. body         `application/json`, small, an object                                          415 / 413 / 422
//   7. service      the checks of `topup-service.ts` and the page to go to           200 { intentId, url }, or a code
//
// The workspace is the one the access check found for the address; nothing in the body names one. The answer is
// `Cache-Control: no-store` and holds a page and an intent id, never the profile. Never credits: the success page only says
// the payment is on its way (#505), and the balance changes when the webhook arrives (#502). The log gets the workspace id and
// a result code, never an amount, a name, a page or a person.
import "server-only";
import type { SignInPermission } from "../auth/sign-in-limit.ts";
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { BillingAdapter } from "./adapter.ts";
import { guardBillingRoute, type BillingRouteGuard } from "./enabled.ts";
import type { TopUpErrorCode, TopUpService } from "./topup-service.ts";

/** A top-up is an amount, a flag and an id: a few hundred bytes. */
export const TOP_UP_REQUEST_MAX_BYTES = 4 * 1024;

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = JsonBodyErrorCode | TopUpErrorCode | "rate_limited";

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  rate_limited: 429,
  forbidden: 403,
  amount_invalid: 422,
  amount_out_of_range: 422,
  intent_id_invalid: 422,
  vat_id_rejected: 422,
  checkout_unavailable: 409,
  profile_required: 409,
  business_confirmation_required: 409,
  intent_conflict: 409,
  request_in_progress: 409,
  provider_unavailable: 502,
  provider_rejected: 502,
  provider_not_configured: 503,
};

function refusal(code: RefusalCode, retryAfterSeconds?: number): Response {
  return Response.json(
    { error: code },
    {
      status: STATUS[code],
      headers: {
        ...NO_STORE,
        ...(retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(retryAfterSeconds) }),
      },
    },
  );
}

/**
 * Resolves the person and their role for `manage_billing`, then runs the handler: the route file passes
 * `(handler) => withWorkspace(workspace, "manage_billing", handler)`, so the guard stays where every other workspace route
 * has it (and `src/workspaces/guard-rule.test.ts` can see it).
 */
export type WithAccess = (
  handler: (access: WorkspaceAccess) => Promise<Response>,
) => Promise<Response>;

export type TopUpRouteDependencies = {
  guard: BillingRouteGuard;
  /** The adapter billing is set to, or undefined when none is. */
  activeAdapter: () => Promise<BillingAdapter | undefined>;
  /** The service for that adapter. */
  serviceFor: (adapter: BillingAdapter) => TopUpService;
  limits: {
    hit(input: {
      workspaceId: string;
      userId: string;
    }): Promise<SignInPermission>;
  };
  /** The configured public address of the app, never a request header. */
  baseUrl: string;
  log: { info(line: string): void };
};

export type TopUpRoute = {
  post(
    request: Request,
    slug: string,
    withAccess: WithAccess,
  ): Promise<Response>;
};

export function createTopUpRoute({
  guard,
  activeAdapter,
  serviceFor,
  limits,
  baseUrl,
  log,
}: TopUpRouteDependencies): TopUpRoute {
  const origin = baseUrl.replace(/\/+$/, "");
  return {
    post: guardBillingRoute(
      guard,
      async (request: Request, slug: string, withAccess: WithAccess) => {
        const adapter = await activeAdapter();
        if (adapter === undefined || !adapter.capabilities.checkout)
          return guard.notFound();
        if (isCrossSite(request)) return refusal("cross_site_request");
        return withAccess(async (access) => {
          const workspaceId = access.workspace.id;
          const permission = await limits.hit({
            workspaceId,
            userId: access.user.id,
          });
          if (!permission.allowed) {
            log.info(
              `[billing] TOPUP_STARTED workspace=${workspaceId} result=rate_limited`,
            );
            return refusal("rate_limited", permission.retryAfterSeconds);
          }
          const body = await readJsonObject(request, TOP_UP_REQUEST_MAX_BYTES);
          if (!body.ok) return refusal(body.error);
          const result = await serviceFor(adapter).start(
            {
              workspaceId,
              userId: access.user.id,
              role: access.role,
            },
            {
              amountCents: body.value.amountCents,
              confirmBusiness: body.value.confirmBusiness,
              intentId: body.value.intentId,
              returnUrl: `${origin}${workspacePath(access.workspace.slug, "/billing")}`,
            },
          );
          if (!result.ok) return refusal(result.error);
          return Response.json(
            { intentId: result.intentId, url: result.url },
            { headers: NO_STORE },
          );
        });
      },
    ),
  };
}
