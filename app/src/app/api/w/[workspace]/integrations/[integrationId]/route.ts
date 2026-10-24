// SPDX-License-Identifier: LicenseRef-Proprietary

// DELETE /api/w/:workspace/integrations/:integrationId: ends a connection of the workspace (an Owner or Admin).
// The connection and its repositories are switched off; projects, runs and the link of the installation to the
// workspace stay, and nothing changes on GitHub. Protected like every workspace route. The logic is in
// src/installation-binding/.
import { connection } from "next/server";
import { getBindingRouteHandlers } from "@/installation-binding/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/integrations/[integrationId]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, integrationId } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getBindingRouteHandlers().disconnect(request, access, integrationId),
  );
}
