// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/invitations/:invitationId/resend: mails a new link for an open invitation and stops
// the old one (only while the instance has a mail server: a link without one is shown once). Same rights as
// inviting with that role. Protected like every workspace route (src/workspaces/access-runtime.ts). The
// logic is in src/workspaces/http.ts.
import { connection } from "next/server";
import { withWorkspace } from "@/workspaces/access-runtime";
import { getWorkspaceRouteHandlers } from "@/workspaces/shared";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/invitations/[invitationId]/resend">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, invitationId } = await context.params;
  return withWorkspace(workspace, "manage_invitations", (access) =>
    getWorkspaceRouteHandlers().resendInvitation(request, access, invitationId),
  );
}
