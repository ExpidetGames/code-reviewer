// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/repositories/:repositoryId/reviews: starts a command (review, improve, describe,
// ask) for an open pull request of a project. Every member may start a review. Protected like every
// workspace route (src/workspaces/access-runtime.ts). The logic is in src/manual-reviews/http.ts.
import { connection } from "next/server";
import { createManualReviewRouteHandlers } from "@/manual-reviews/http";
import { manualReviewServiceFor } from "@/manual-reviews/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/reviews">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "start_review", (access) =>
    createManualReviewRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: manualReviewServiceFor(access.workspace.id),
    }).start(request, repositoryId),
  );
}
