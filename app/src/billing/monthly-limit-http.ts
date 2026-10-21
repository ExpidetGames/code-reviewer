// SPDX-License-Identifier: Apache-2.0

// The handlers behind `GET` and `PUT /api/w/:workspace/billing/monthly-limit` (ADR 0006, 2.9; #499), with their collaborators
// passed in so the route file only wires the real ones in (`shared.ts`) and tests wire the real service over a test database. The
// order is the contract; each step ends the request on failure:
//
//   1. billing      off: the 404 of a path that does not exist, before anything else is read or asked
//   2. same site    `Sec-Fetch-Site` / `Origin` (a change only)                                   403 cross_site_request
//   3. access       the session and the role (`manage_billing`: an Admin or an Owner)    401 / 404 / 403, access-response.ts
//   4. body         `application/json`, small, an object (a change only)                          415 / 413 / 422
//   5. service      the checks of `monthly-limit-service.ts`                                      200 { monthlyLimitCents }, or a code
//
// The workspace is the one the access check found for the address; nothing in the body names one. The answer is
// `Cache-Control: no-store`. The form that calls it is #505.
import "server-only";
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import { guardBillingRoute, type BillingRouteGuard } from "./enabled.ts";
import type {
  MonthlyLimitErrorCode,
  MonthlyLimitResult,
  MonthlyLimitService,
} from "./monthly-limit-service.ts";
import type { WithAccess } from "./topup-http.ts";

/** A change is one number: a few dozen bytes. */
export const MONTHLY_LIMIT_REQUEST_MAX_BYTES = 1024;

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = JsonBodyErrorCode | MonthlyLimitErrorCode;

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  forbidden: 403,
  limit_invalid: 422,
  limit_out_of_range: 422,
};

function refusal(code: RefusalCode): Response {
  return Response.json(
    { error: code },
    { status: STATUS[code], headers: NO_STORE },
  );
}

function answer(result: MonthlyLimitResult): Response {
  if (!result.ok) return refusal(result.error);
  return Response.json(
    { monthlyLimitCents: result.monthlyLimitCents },
    { headers: NO_STORE },
  );
}

export type MonthlyLimitRouteDependencies = {
  guard: BillingRouteGuard;
  service: MonthlyLimitService;
};

export type MonthlyLimitRoute = {
  get(
    request: Request,
    slug: string,
    withAccess: WithAccess,
  ): Promise<Response>;
  put(
    request: Request,
    slug: string,
    withAccess: WithAccess,
  ): Promise<Response>;
};

export function createMonthlyLimitRoute({
  guard,
  service,
}: MonthlyLimitRouteDependencies): MonthlyLimitRoute {
  const actorOf = (access: Parameters<Parameters<WithAccess>[0]>[0]) => ({
    workspaceId: access.workspace.id,
    userId: access.user.id,
    role: access.role,
  });
  return {
    get: guardBillingRoute(
      guard,
      async (_request: Request, _slug: string, withAccess: WithAccess) =>
        withAccess(async (access) =>
          answer(await service.get(actorOf(access))),
        ),
    ),

    put: guardBillingRoute(
      guard,
      async (request: Request, _slug: string, withAccess: WithAccess) => {
        if (isCrossSite(request)) return refusal("cross_site_request");
        return withAccess(async (access) => {
          const body = await readJsonObject(
            request,
            MONTHLY_LIMIT_REQUEST_MAX_BYTES,
          );
          if (!body.ok) return refusal(body.error);
          return answer(await service.set(actorOf(access), body.value));
        });
      },
    ),
  };
}
