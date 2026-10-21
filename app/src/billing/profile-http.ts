// SPDX-License-Identifier: Apache-2.0

// The handlers behind `GET` and `PUT /api/w/:workspace/billing/profile` (ADR 0006, 2.13; #505), with their collaborators passed in
// so the route file only wires the real ones in (`shared.ts`) and tests wire the real service over a test database. The order is
// the contract; each step ends the request on failure:
//
//   1. billing      off: the 404 of a path that does not exist, before anything else is read or asked
//   2. same site    `Sec-Fetch-Site` / `Origin` (a change only)                                   403 cross_site_request
//   3. access       the session and the role (`manage_billing`: an Admin or an Owner)    401 / 404 / 403, access-response.ts
//   4. body         `application/json`, small, an object (a change only)                          415 / 413 / 422
//   5. service      `profile-service.ts`: the fields are judged by `profile.ts`   200 { profile }, 422 { error, issues }
//
// The workspace is the one the access check found for the address; nothing in the body names one. The profile is customer data:
// the answer is `Cache-Control: no-store`, a refusal names a FIELD and a code and never the value, and nothing here logs. The
// business confirmation is not part of this route: it is given with the first top-up (`topup-service.ts`).
import "server-only";
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import { guardBillingRoute, type BillingRouteGuard } from "./enabled.ts";
import type { BillingActor, BillingProfileService } from "./profile-service.ts";
import type { WithAccess } from "./topup-http.ts";

/** A profile is a handful of short fields: a few hundred bytes, 8 KiB at the most. */
export const PROFILE_REQUEST_MAX_BYTES = 8 * 1024;

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = JsonBodyErrorCode | "forbidden";

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  forbidden: 403,
};

function refusal(code: RefusalCode): Response {
  return Response.json(
    { error: code },
    { status: STATUS[code], headers: NO_STORE },
  );
}

export type ProfileRouteDependencies = {
  guard: BillingRouteGuard;
  service: BillingProfileService;
};

export type ProfileRoute = {
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

export function createProfileRoute({
  guard,
  service,
}: ProfileRouteDependencies): ProfileRoute {
  const actorOf = (
    access: Parameters<Parameters<WithAccess>[0]>[0],
  ): BillingActor => ({
    workspaceId: access.workspace.id,
    userId: access.user.id,
    role: access.role,
  });
  return {
    get: guardBillingRoute(
      guard,
      async (_request: Request, _slug: string, withAccess: WithAccess) =>
        withAccess(async (access) => {
          const result = await service.get(actorOf(access));
          if (!result.ok) return refusal(result.error);
          return Response.json(
            { profile: result.profile },
            { headers: NO_STORE },
          );
        }),
    ),

    put: guardBillingRoute(
      guard,
      async (request: Request, _slug: string, withAccess: WithAccess) => {
        if (isCrossSite(request)) return refusal("cross_site_request");
        return withAccess(async (access) => {
          const body = await readJsonObject(request, PROFILE_REQUEST_MAX_BYTES);
          if (!body.ok) return refusal(body.error);
          const result = await service.save(actorOf(access), body.value);
          if (result.ok)
            return Response.json(
              { profile: result.profile },
              { headers: NO_STORE },
            );
          if (result.error === "forbidden") return refusal("forbidden");
          return Response.json(
            { error: result.error, issues: result.issues },
            { status: JSON_BODY_ERROR_STATUS.invalid_input, headers: NO_STORE },
          );
        });
      },
    ),
  };
}
