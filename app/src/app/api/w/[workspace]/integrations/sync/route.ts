// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/integrations/sync: reads the connections of the workspace from GitHub now (an Owner or
// Admin). It concerns the workspace's own connections only and answers `{ added, errors }` for them; the
// synchronization of the whole instance stays the instance admin's (`/api/admin/integrations/sync`). Protected
// like every workspace route. The logic is in src/installation-binding/http.ts.
import { connection } from "next/server";
import { getBindingRouteHandlers } from "@/installation-binding/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/integrations/sync">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getBindingRouteHandlers().syncWorkspace(request, access),
  );
}
