// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/runs?repository=<id>&status=<status>: the list of runs the Runs page polls.
// Protected: the proxy lets a member of the workspace through (anybody else gets the answer of a path that
// does not exist), and `withWorkspace` is the second guard: it checks the membership and the role before
// the service for that workspace is made. The logic is in src/runs/http.ts.
import { connection } from "next/server";
import { createRunsRouteHandlers } from "@/runs/http";
import { runsServiceFor } from "@/runs/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runs">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createRunsRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: runsServiceFor(access.workspace.id),
    }).list(request),
  );
}
