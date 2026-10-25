// SPDX-License-Identifier: LicenseRef-Proprietary

// PATCH  /api/w/:workspace/members/:userId  { "role": "owner" | "admin" | "member" }: gives a member another
//        role (an Owner).
// DELETE /api/w/:workspace/members/:userId: takes a member out; for the person's own id it is leaving, which
//        every member may do. Who may remove whom, and that the last Owner stays, is decided by the service
//        from the roles in the database (src/workspaces/members.ts), so the route only needs a member.
// Protected like every workspace route (src/workspaces/access-runtime.ts). The logic is in
// src/workspaces/http.ts.
import { connection } from "next/server";
import { withWorkspace } from "@/workspaces/access-runtime";
import { getWorkspaceRouteHandlers } from "@/workspaces/shared";

type Context = RouteContext<"/api/w/[workspace]/members/[userId]">;

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, userId } = await context.params;
  return withWorkspace(workspace, "change_member_roles", (access) =>
    getWorkspaceRouteHandlers().changeRole(request, access, userId),
  );
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  await connection();
  const { workspace, userId } = await context.params;
  return withWorkspace(workspace, "view_members", (access) =>
    getWorkspaceRouteHandlers().removeMember(request, access, userId),
  );
}
