// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/invitations  { "email": "...", "role": "admin" | "member" | "owner" }: invites a
// person. An Owner invites with any role, an Admin Members only; the service decides from the role the
// person has in the database, so this route only needs an Admin or an Owner (a Member is refused here
// already). The answer holds the link once when the instance has no mail server. Protected like every
// workspace route (src/workspaces/access-runtime.ts). The logic is in src/workspaces/http.ts.
import { connection } from "next/server";
import { withWorkspace } from "@/workspaces/access-runtime";
import { getWorkspaceRouteHandlers } from "@/workspaces/shared";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/invitations">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_invitations", (access) =>
    getWorkspaceRouteHandlers().invite(request, access),
  );
}
