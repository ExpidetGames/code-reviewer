// SPDX-License-Identifier: Apache-2.0

// PUT|DELETE /api/admin/billing/plans/:planKey: one change to a plan, or the deletion of a plan that has no version (#438),
// for the instance admin only; the 404 of a missing path while billing is off. See src/billing/plans-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createPlansRouteHandlers } from "@/billing/plans-http";
import { getBillingPlansService, isBillingOnNow } from "@/billing/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createPlansRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    isOn: isBillingOnNow,
    service: getBillingPlansService(),
  });
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/instance-portal/billing/plans/[planKey]">,
): Promise<Response> {
  const { planKey } = await context.params;
  return (await handlers()).change(request, planKey);
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/instance-portal/billing/plans/[planKey]">,
): Promise<Response> {
  const { planKey } = await context.params;
  return (await handlers()).remove(request, planKey);
}
