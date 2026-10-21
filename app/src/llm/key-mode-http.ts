// SPDX-License-Identifier: Apache-2.0

// The handlers behind `GET` and `PUT /api/w/:workspace/llm-key-mode` (ADR 0006, P3, D4; #496), with their collaborators passed in so
// the route file only wires the real ones in (`key-mode-shared.ts`) and tests wire the real service over a test database. The order
// is the contract; each step ends the request on failure:
//
//   1. billing      off: the 404 of a path that does not exist, before anything else is read or asked (the choice exists only while
//                   billing is on; with billing off the entitlements decide, as ever)
//   2. same site    `Sec-Fetch-Site` / `Origin` (a change only)                                   403 cross_site_request
//   3. access       the session and the role (a change: `manage_llm_key`, an Admin or an Owner)  401 / 404 / 403, access-response.ts
//   4. body         `application/json`, small, an object (a change only)                          415 / 413 / 422
//   5. service      the checks of `key-mode-service.ts`                                           200 { keyMode }, or a code
//
// The workspace is the one the access check found for the address; nothing in the body names one. The answer is
// `Cache-Control: no-store`.
import "server-only";
import { actorName } from "../auth/access-policy.ts";
import {
  guardBillingRoute,
  type BillingRouteGuard,
} from "../billing/enabled.ts";
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import type {
  KeyModeErrorCode,
  KeyModeResult,
  LlmKeyModeService,
} from "./key-mode-service.ts";

/** A change is one word: a few dozen bytes. */
export const KEY_MODE_REQUEST_MAX_BYTES = 1024;

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = JsonBodyErrorCode | KeyModeErrorCode;

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  forbidden: 403,
  key_mode_invalid: 422,
  own_key_missing: 409,
};

function refusal(code: RefusalCode): Response {
  return Response.json(
    { error: code },
    { status: STATUS[code], headers: NO_STORE },
  );
}

function answer(result: KeyModeResult): Response {
  if (!result.ok) return refusal(result.error);
  return Response.json({ keyMode: result.keyMode }, { headers: NO_STORE });
}

/** The same shape as every billing route: the route file passes the access check of its action in. */
export type WithAccess = (
  handler: (access: WorkspaceAccess) => Promise<Response>,
) => Promise<Response>;

export type LlmKeyModeRouteDependencies = {
  guard: BillingRouteGuard;
  service: LlmKeyModeService;
};

export type LlmKeyModeRoute = {
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

export function createLlmKeyModeRoute({
  guard,
  service,
}: LlmKeyModeRouteDependencies): LlmKeyModeRoute {
  return {
    get: guardBillingRoute(
      guard,
      async (_request: Request, _slug: string, withAccess: WithAccess) =>
        withAccess(async (access) =>
          answer(await service.get(access.workspace.id)),
        ),
    ),

    put: guardBillingRoute(
      guard,
      async (request: Request, _slug: string, withAccess: WithAccess) => {
        if (isCrossSite(request)) return refusal("cross_site_request");
        return withAccess(async (access) => {
          const body = await readJsonObject(
            request,
            KEY_MODE_REQUEST_MAX_BYTES,
          );
          if (!body.ok) return refusal(body.error);
          return answer(
            await service.set(
              {
                workspaceId: access.workspace.id,
                userId: access.user.id,
                name: actorName(access.user),
                role: access.role,
              },
              body.value,
            ),
          );
        });
      },
    ),
  };
}
