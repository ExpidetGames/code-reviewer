// SPDX-License-Identifier: LicenseRef-Proprietary

// The handler behind `POST /api/w/:workspace/billing/top-ups/:id/check` ("Check payment", ADR 0006, 2.13; #502), with its
// collaborators passed in so the route file only wires the real ones in (`shared.ts`) and tests wire the real services over a test
// database. The order is the contract; each step ends the request on failure:
//
//   1. billing      off: the 404 of a path that does not exist, before anything else is read or asked
//   2. adapter      none, or one that cannot be asked about a top-up (`manual`): the same 404
//   3. same site    `Sec-Fetch-Site` / `Origin` (src/http/request-checks.ts)                      403 cross_site_request
//   4. access       the session and the role (`manage_billing`: an Admin or an Owner)    401 / 404 / 403, access-response.ts
//   5. limit        per person and workspace, and for the whole instance (every check asks the provider)
//                   429 rate_limited, 503 top_ups_busy, fail closed when the counters cannot be read 503 limits_unavailable
//   6. service      `topup-check.ts`: the intent of THIS workspace, the provider's answer applied      200 { intentId, state }
//
// There is no body: the intent is the one in the address, looked up in the workspace the access check found. The answer is
// `Cache-Control: no-store` and holds the id and the state of the intent, nothing of the provider.
import "server-only";
import { isCrossSite } from "../http/request-checks.ts";
import type { BillingAdapter } from "./adapter.ts";
import { guardBillingRoute, type BillingRouteGuard } from "./enabled.ts";
import type { TopUpCheckErrorCode, TopUpCheckService } from "./topup-check.ts";
import type { WithAccess } from "./topup-http.ts";
import type { TopUpPermission } from "./topup-limits.ts";

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode =
  | TopUpCheckErrorCode
  | "cross_site_request"
  | "rate_limited"
  | "top_ups_busy"
  | "limits_unavailable";

const STATUS: Record<RefusalCode, number> = {
  cross_site_request: 403,
  rate_limited: 429,
  top_ups_busy: 503,
  limits_unavailable: 503,
  forbidden: 403,
  intent_not_found: 404,
  provider_unavailable: 503,
  provider_rejected: 503,
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

export type TopUpCheckRouteDependencies = {
  guard: BillingRouteGuard;
  activeAdapter: () => Promise<BillingAdapter | undefined>;
  serviceFor: (adapter: BillingAdapter) => TopUpCheckService;
  limits: {
    hit(input: {
      workspaceId: string;
      userId: string;
    }): Promise<TopUpPermission>;
  };
  log: { info(line: string): void };
};

export type TopUpCheckRoute = {
  post(
    request: Request,
    slug: string,
    intentId: string,
    withAccess: WithAccess,
  ): Promise<Response>;
};

export function createTopUpCheckRoute({
  guard,
  activeAdapter,
  serviceFor,
  limits,
  log,
}: TopUpCheckRouteDependencies): TopUpCheckRoute {
  return {
    post: guardBillingRoute(
      guard,
      async (
        request: Request,
        _slug: string,
        intentId: string,
        withAccess: WithAccess,
      ) => {
        const adapter = await activeAdapter();
        if (adapter?.lookupTopUp === undefined) return guard.notFound();
        if (isCrossSite(request)) return refusal("cross_site_request");
        return withAccess(async (access) => {
          const workspaceId = access.workspace.id;
          let permission: TopUpPermission;
          try {
            permission = await limits.hit({
              workspaceId,
              userId: access.user.id,
            });
          } catch {
            log.info(
              `[billing] TOPUP_CHECKED workspace=${workspaceId} result=limits_unavailable`,
            );
            return refusal("limits_unavailable");
          }
          if (!permission.allowed) {
            const code =
              permission.scope === "instance" ? "top_ups_busy" : "rate_limited";
            log.info(
              `[billing] TOPUP_CHECKED workspace=${workspaceId} result=${code}`,
            );
            return refusal(code, permission.retryAfterSeconds);
          }
          const result = await serviceFor(adapter).check(
            { workspaceId, userId: access.user.id, role: access.role },
            intentId,
          );
          if (!result.ok) return refusal(result.error);
          return Response.json(
            { intentId: result.intentId, state: result.state },
            { headers: NO_STORE },
          );
        });
      },
    ),
  };
}
