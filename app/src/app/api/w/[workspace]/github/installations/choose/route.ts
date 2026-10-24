// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/github/installations/choose { picker, installationId }: links one installation of the
// list (an Owner or Admin): answers the address of GitHub's authorization page, after which the same checks as
// for "Connect GitHub" decide. Protected and limited like it. The logic is in src/installation-binding/.
import { connection } from "next/server";
import { getBindingRouteHandlers } from "@/installation-binding/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/github/installations/choose">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getBindingRouteHandlers().choose(request, access),
  );
}
