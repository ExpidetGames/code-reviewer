// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/billing/top-ups/:id/check ("Check payment"): asks the payment provider what became of a top-up of this
// workspace and applies the answer like a webhook would have, once. It repairs a lost webhook and makes the success page reliable.
// An Owner or an Admin (`manage_billing`); a missing path while billing is off or the active adapter cannot be asked; same site
// only; limited per person and workspace. The logic is in src/billing/topup-check-http.ts.
import { connection } from "next/server";
import { getTopUpCheckRoute } from "@/billing/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/top-ups/[id]/check">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, id } = await context.params;
  return getTopUpCheckRoute().post(request, workspace, id, (handler) =>
    withWorkspace(workspace, "manage_billing", handler),
  );
}
