// SPDX-License-Identifier: Apache-2.0

// PATCH /api/w/:workspace  { "name": "..." }: renames the workspace (an Owner; the address stays).
// DELETE /api/w/:workspace  { "confirmName": "..." }: deletes it (an Owner who types its name, #658). Protected
// like every workspace route (src/workspaces/access-runtime.ts), and the service decides again from the role
// the person has in the database. The logic is in src/workspaces/http.ts.
import { connection } from "next/server";
import { withWorkspace } from "@/workspaces/access-runtime";
import { getWorkspaceRouteHandlers } from "@/workspaces/shared";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/w/[workspace]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "rename_workspace", (access) =>
    getWorkspaceRouteHandlers().rename(request, access),
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]">,
): Promise<Response> {
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "delete_workspace", (access) =>
    getWorkspaceRouteHandlers().deleteWorkspace(request, access),
  );
}
