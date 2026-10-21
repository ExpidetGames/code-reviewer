// SPDX-License-Identifier: Apache-2.0

// The handler behind `GET /api/w/:workspace/billing/journal` (ADR 0006, 2.5; #505), with its collaborators passed in so the route
// file only wires the real ones in (`shared.ts`) and tests wire the real service over a test database. The order is the contract;
// each step ends the request on failure:
//
//   1. billing      off: the 404 of a path that does not exist, before anything else is read or asked
//   2. access       the session and the role (`view`: every member of the workspace)           401 / 404, access-response.ts
//   3. query        `cursor` (the opaque text of the previous page) and `limit` (1 to 50)              422 journal_query_invalid
//   4. service      one page of the journal of THIS workspace                                  200 { rows, next }
//
// The workspace is the one the access check found for the address. The answer is `Cache-Control: no-store` and holds the
// customer's rows only (`workspace-billing/view.ts`): final prices, no rate, no minute count, no reference, no note.
import "server-only";
import { guardBillingRoute, type BillingRouteGuard } from "./enabled.ts";
import type { WithAccess } from "./topup-http.ts";
import type {
  WorkspaceBillingErrorCode,
  WorkspaceBillingService,
} from "./workspace-page.ts";

const NO_STORE = { "cache-control": "no-store" };

const STATUS: Record<WorkspaceBillingErrorCode, number> = {
  forbidden: 403,
  journal_query_invalid: 422,
};

export type JournalRouteDependencies = {
  guard: BillingRouteGuard;
  service: WorkspaceBillingService;
};

export type JournalRoute = {
  get(
    request: Request,
    slug: string,
    withAccess: WithAccess,
  ): Promise<Response>;
};

export function createJournalRoute({
  guard,
  service,
}: JournalRouteDependencies): JournalRoute {
  return {
    get: guardBillingRoute(
      guard,
      async (request: Request, _slug: string, withAccess: WithAccess) =>
        withAccess(async (access) => {
          const params = new URL(request.url).searchParams;
          const result = await service.journal(
            {
              workspaceId: access.workspace.id,
              userId: access.user.id,
              role: access.role,
            },
            {
              cursor: params.get("cursor") ?? undefined,
              limit: params.get("limit") ?? undefined,
            },
          );
          if (!result.ok)
            return Response.json(
              { error: result.error },
              { status: STATUS[result.error], headers: NO_STORE },
            );
          return Response.json(result.page, { headers: NO_STORE });
        }),
    ),
  };
}
