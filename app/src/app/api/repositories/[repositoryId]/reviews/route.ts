// SPDX-License-Identifier: Apache-2.0

// POST /api/repositories/:repositoryId/reviews: starts a command (review, improve, describe, ask) for
// an open pull request of a project. Protected: the proxy asks for a session, and `requireUser()`
// (called by the handler) is the second guard. The logic is in src/manual-reviews/http.ts.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { createManualReviewRouteHandlers } from "@/manual-reviews/http";
import { getManualReviewService } from "@/manual-reviews/shared";

export async function POST(
  request: Request,
  context: RouteContext<"/api/repositories/[repositoryId]/reviews">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { repositoryId } = await context.params;
  return createManualReviewRouteHandlers({
    // The second guard behind the proxy (src/auth/README.md): called first, before any data is read.
    requireUser: () => requireUser(),
    service: getManualReviewService(),
  }).start(request, repositoryId);
}
