// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/billing/invoices: the invoices the payment provider issued for the top-ups of the workspace, newest first
// (#659). Owners and Admins only; a missing path while billing is off. The logic is in src/billing/invoices-http.ts.
import { connection } from "next/server";
import { getInvoicesRoute } from "@/billing/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/invoices">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return getInvoicesRoute().get(request, workspace, (handler) =>
    withWorkspace(workspace, "manage_billing", handler),
  );
}
