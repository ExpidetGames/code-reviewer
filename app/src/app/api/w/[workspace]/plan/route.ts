// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/plan: what the workspace may use and has used in the current period, which the plan page
// polls (#282). Protected: the proxy lets a member of the workspace through (anybody else gets the answer of a path
// that does not exist), and `withWorkspace` is the second guard. Every member may read it. The logic is in
// src/usage/ (the view) and the answer is never cached.
import { connection } from "next/server";
import { planResponse } from "@/usage/http";
import { planViewFor } from "@/usage/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/w/[workspace]/plan">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "view", async (access) =>
    planResponse(await planViewFor(access.workspace.id)),
  );
}
