// SPDX-License-Identifier: Apache-2.0

// GET /api/admin/billing/workspaces/:id: the balance of a workspace and its recent journal entries, for the instance admin
// only. The logic is in src/billing/admin-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createBillingRouteHandlers } from "@/billing/admin-http";
import {
  getBillingAdminService,
  getBillingCreditService,
} from "@/billing/shared";

export async function GET(
  request: Request,
  context: RouteContext<"/api/instance-portal/billing/workspaces/[id]">,
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
  }).workspace(request, id);
}
