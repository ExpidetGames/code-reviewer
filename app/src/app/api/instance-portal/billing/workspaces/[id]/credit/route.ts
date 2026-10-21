// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/billing/workspaces/:id/credit: a manual credit or a signed correction of the balance of a workspace with a
// required note, written through the manual adapter with the admin as the actor, for the instance admin only. The logic is in
// src/billing/admin-http.ts and admin-credit-service.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createBillingRouteHandlers } from "@/billing/admin-http";
import {
  getBillingAdminService,
  getBillingCreditService,
  getBillingReviewService,
} from "@/billing/shared";

export async function POST(
  request: Request,
  context: RouteContext<"/api/instance-portal/billing/workspaces/[id]/credit">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { id } = await context.params;
  return createBillingRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getBillingAdminService(),
    credit: getBillingCreditService(),
    reviews: getBillingReviewService(),
  }).credit(request, id);
}
