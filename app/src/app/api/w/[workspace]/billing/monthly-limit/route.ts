// SPDX-License-Identifier: LicenseRef-Proprietary

// GET and PUT /api/w/:workspace/billing/monthly-limit: read and set the optional monthly total limit of the workspace (ADR 0006,
// 2.9; #499). An Owner or an Admin (`manage_billing`); a missing path while billing is off; same site only for a change. A
// review is refused at the claim when the month's charges plus its hold would pass the limit; a run that started is never
// stopped by it. The logic is in src/billing/monthly-limit-http.ts.
import { connection } from "next/server";
import { getMonthlyLimitRoute } from "@/billing/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/monthly-limit">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return getMonthlyLimitRoute().get(request, workspace, (handler) =>
    withWorkspace(workspace, "manage_billing", handler),
  );
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/monthly-limit">,
): Promise<Response> {
  await connection();
  const { workspace } = await context.params;
  return getMonthlyLimitRoute().put(request, workspace, (handler) =>
    withWorkspace(workspace, "manage_billing", handler),
  );
}
