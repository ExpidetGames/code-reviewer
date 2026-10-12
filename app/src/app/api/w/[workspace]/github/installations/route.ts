// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/github/installations {}: starts the list of installations the person can link ("Link an
// existing installation", an Owner or Admin) and answers the address of GitHub's authorization page. Protected
// and limited like "Connect GitHub". The logic is in src/installation-binding/.
import { connection } from "next/server";
import { getBindingRouteHandlers } from "@/installation-binding/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/github/installations">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getBindingRouteHandlers().startPicker(request, access),
  );
}
