// SPDX-License-Identifier: Apache-2.0

// PUT /api/repositories/:repositoryId/project: switches the project of a repository on or off.
// Protected: the proxy asks for a session, and `requireUser()` (called by the handler) is the second
// guard. The logic is in src/projects/http.ts.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { createProjectRouteHandler } from "@/projects/http";
import { getProjectService } from "@/projects/shared";

export async function PUT(
  request: Request,
  context: RouteContext<"/api/repositories/[repositoryId]/project">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { repositoryId } = await context.params;
  return createProjectRouteHandler({
    // The second guard behind the proxy (src/auth/README.md): called first, before any data is read.
    // The proxy answers a request without a session with 401 (or 403) before it gets here; if it ever
    // does not (a changed matcher), `requireUser()` redirects to the login page (a 307 for this PUT).
    requireUser: () => requireUser(),
    service: getProjectService(),
  })(request, repositoryId);
}
