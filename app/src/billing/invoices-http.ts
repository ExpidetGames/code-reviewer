// SPDX-License-Identifier: LicenseRef-Proprietary

// The handler behind `GET /api/w/:workspace/billing/invoices` (#659), with its collaborators passed in so the route file only
// wires the real ones in (`shared.ts`) and tests wire the real service over a test database. The order is the contract; each
// step ends the request on failure:
//
//   1. billing      off: the 404 of a path that does not exist, before anything else is read or asked
//   2. access       the session and the role (`manage_billing`: an Owner or an Admin)        401 / 404 / 403, access-response.ts
//   3. service      the invoices of THIS workspace; the role is judged again there
//                   403 forbidden, 502 provider_unavailable / provider_rejected, 503 provider_not_configured
//                                                                                              200 { invoices }
//
// The page of a workspace shows the invoices to an Owner and an Admin only, and so does this route.
// The answer is `Cache-Control: no-store`; it holds the invoice rows only (`workspace-billing/view.ts`).
import "server-only";
import { guardBillingRoute, type BillingRouteGuard } from "./enabled.ts";
import type { InvoicesErrorCode, InvoicesService } from "./invoices-service.ts";
import type { WithAccess } from "./topup-http.ts";

const NO_STORE = { "cache-control": "no-store" };

const STATUS: Record<InvoicesErrorCode, number> = {
  forbidden: 403,
  provider_unavailable: 502,
  provider_rejected: 502,
  provider_not_configured: 503,
};

export type InvoicesRouteDependencies = {
  guard: BillingRouteGuard;
  service: InvoicesService;
};

export type InvoicesRoute = {
  get(
    request: Request,
    slug: string,
    withAccess: WithAccess,
  ): Promise<Response>;
};

export function createInvoicesRoute({
  guard,
  service,
}: InvoicesRouteDependencies): InvoicesRoute {
  return {
    get: guardBillingRoute(
      guard,
      async (_request: Request, _slug: string, withAccess: WithAccess) =>
        withAccess(async (access) => {
          const result = await service.list({
            workspaceId: access.workspace.id,
            userId: access.user.id,
            role: access.role,
          });
          if (!result.ok)
            return Response.json(
              { error: result.error },
              { status: STATUS[result.error], headers: NO_STORE },
            );
          return Response.json(result.list, { headers: NO_STORE });
        }),
    ),
  };
}
