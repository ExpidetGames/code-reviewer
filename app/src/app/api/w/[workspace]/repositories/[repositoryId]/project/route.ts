// SPDX-License-Identifier: Apache-2.0

// PUT /api/w/:workspace/repositories/:repositoryId/project: switches the project of a repository on or off.
// Which repositories are reviewed is managed by Admins and Owners. Protected like every workspace route
// (src/workspaces/access-runtime.ts); the repository is looked up in the workspace of the address. The
// logic is in src/projects/http.ts.
import { connection } from "next/server";
import { createProjectRouteHandler } from "@/projects/http";
import { projectServiceFor } from "@/projects/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/project">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "manage_projects", (access) =>
    createProjectRouteHandler({
      requireUser: () => Promise.resolve(access.user),
      service: projectServiceFor(access.workspace.id),
    })(request, repositoryId),
  );
}
