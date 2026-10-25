// SPDX-License-Identifier: LicenseRef-Proprietary

// DELETE /api/w/:workspace/invitations/:invitationId: revokes an invitation that is still open (an Owner, or
// an Admin for an invitation of a Member). Protected like every workspace route
// (src/workspaces/access-runtime.ts); the invitation is looked up in the workspace of the address. The
// logic is in src/workspaces/http.ts.
import { connection } from "next/server";
import { withWorkspace } from "@/workspaces/access-runtime";
import { getWorkspaceRouteHandlers } from "@/workspaces/shared";

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/invitations/[invitationId]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, invitationId } = await context.params;
  return withWorkspace(workspace, "manage_invitations", (access) =>
    getWorkspaceRouteHandlers().revokeInvitation(request, access, invitationId),
  );
}
