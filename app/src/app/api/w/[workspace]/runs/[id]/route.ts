// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/runs/:id: one run, as the detail page polls it while the run is waiting or
// running. Protected like the list: the workspace is the one in the address, for a member only. The run is
// looked up in that workspace; the id of a run of another workspace is a run nobody has. The logic is in
// src/runs/http.ts.
import { connection } from "next/server";
import { createRunsRouteHandlers } from "@/runs/http";
import { runsServiceFor } from "@/runs/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runs/[id]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, id } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createRunsRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: runsServiceFor(access.workspace.id),
    }).detail(request, id),
  );
}
