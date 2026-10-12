// SPDX-License-Identifier: Apache-2.0

// POST /api/workspaces  { "name": "..." }: creates a workspace for the signed in person, who becomes its
// Owner. Only a multi-tenant instance lets people do this (`multi_tenant_required` otherwise), up to the
// instance's limit of workspaces per person (`workspace_limit_reached`). Open to a person who has no
// workspace yet: that is who needs it. Protected: the proxy asks for a session (src/auth/access.ts,
// NO_WORKSPACE_PATHS), and `withSignedIn` is the second guard. The logic is in src/workspaces/http.ts.
import { connection } from "next/server";
import { withSignedIn } from "@/workspaces/access-runtime";
import { getWorkspaceRouteHandlers } from "@/workspaces/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return withSignedIn((user) =>
    getWorkspaceRouteHandlers().create(request, user),
  );
}
