// SPDX-License-Identifier: Apache-2.0

// GET and PUT /api/w/:workspace/billing/profile: read and save the billing profile of the workspace (legal name, address, optional
// VAT ID; ADR 0006, 2.13; #505). An Owner or an Admin (`manage_billing`); a missing path while billing is off; same site only for
// a change. Customer data: never logged. The logic is in src/billing/profile-http.ts.
import { connection } from "next/server";
import { getProfileRoute } from "@/billing/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/profile">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return getProfileRoute().get(request, workspace, (handler) =>
    withWorkspace(workspace, "manage_billing", handler),
  );
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/billing/profile">,
): Promise<Response> {
  await connection();
  const { workspace } = await context.params;
  return getProfileRoute().put(request, workspace, (handler) =>
    withWorkspace(workspace, "manage_billing", handler),
  );
}
