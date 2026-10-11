// SPDX-License-Identifier: Apache-2.0

// GET|PUT|DELETE /api/repositories/:repositoryId/project/settings: the review settings a project
// overrides. Protected: the proxy asks for a session, and `requireUser()` (called by the handlers)
// is the second guard. The logic is in src/review-settings/http.ts.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { createReviewSettingsRouteHandlers } from "@/review-settings/http";
import { getReviewSettingsService } from "@/review-settings/shared";

type Context =
  RouteContext<"/api/repositories/[repositoryId]/project/settings">;

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createReviewSettingsRouteHandlers({
    // The second guard behind the proxy (src/auth/README.md): called first, before any data is read.
    requireUser: () => requireUser(),
    service: getReviewSettingsService(),
  });
}

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  const { repositoryId } = await context.params;
  return (await handlers()).getProject(request, repositoryId);
}

export async function PUT(
  request: Request,
  context: Context,
): Promise<Response> {
  const { repositoryId } = await context.params;
  return (await handlers()).putProject(request, repositoryId);
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  const { repositoryId } = await context.params;
  return (await handlers()).deleteProject(request, repositoryId);
}
