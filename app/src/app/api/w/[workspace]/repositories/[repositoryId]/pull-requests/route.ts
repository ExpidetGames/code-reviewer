// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/repositories/:repositoryId/pull-requests: the open pull requests of a project, for
// the picker of the start button. Every member may start a review, so every member may see the picker.
// Protected like every workspace route (src/workspaces/access-runtime.ts). The logic is in
// src/manual-reviews/http.ts.
import { connection } from "next/server";
import { createManualReviewRouteHandlers } from "@/manual-reviews/http";
import { manualReviewServiceFor } from "@/manual-reviews/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/pull-requests">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "start_review", (access) =>
    createManualReviewRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: manualReviewServiceFor(access.workspace.id),
    }).list(request, repositoryId),
  );
}
