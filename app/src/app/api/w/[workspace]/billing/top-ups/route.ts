// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/billing/top-ups: starts a top-up of the prepaid balance and answers the page of the payment provider
// to send the buyer to. An Owner or an Admin (`manage_billing`); a missing path while billing is off or the active adapter has
// no checkout page; same site only; limited per person and workspace. Never credits. The logic is in src/billing/topup-http.ts.
import { connection } from "next/server";
import { getTopUpRoute } from "@/billing/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/top-ups">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return getTopUpRoute().post(request, workspace, (handler) =>
    withWorkspace(workspace, "manage_billing", handler),
  );
}
