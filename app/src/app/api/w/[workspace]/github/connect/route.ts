// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/github/connect {}: starts "Connect GitHub" (an Owner or Admin) and answers the address
// of the App's installation page on GitHub, with the signed state of the round trip. Protected like every
// workspace route (src/workspaces/access-runtime.ts); limited per person and for the instance. The logic is in
// src/installation-binding/.
import { connection } from "next/server";
import { getBindingRouteHandlers } from "@/installation-binding/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/github/connect">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getBindingRouteHandlers().connect(request, access),
  );
}
