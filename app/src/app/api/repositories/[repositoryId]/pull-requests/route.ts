// GET /api/repositories/:repositoryId/pull-requests: the open pull requests of a project, for the
// picker of the start button. Protected: the proxy asks for a session, and `requireUser()` (called by
// the handler) is the second guard. The logic is in src/manual-reviews/http.ts.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { createManualReviewRouteHandlers } from "@/manual-reviews/http";
import { getManualReviewService } from "@/manual-reviews/shared";

export async function GET(
  request: Request,
  context: RouteContext<"/api/repositories/[repositoryId]/pull-requests">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { repositoryId } = await context.params;
  return createManualReviewRouteHandlers({
    // The second guard behind the proxy (src/auth/README.md): called first, before any data is read.
    requireUser: () => requireUser(),
    service: getManualReviewService(),
  }).list(request, repositoryId);
}
