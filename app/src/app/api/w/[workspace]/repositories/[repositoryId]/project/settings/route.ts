// SPDX-License-Identifier: Apache-2.0

// GET|PUT|DELETE /api/w/:workspace/repositories/:repositoryId/project/settings: the review settings a
// project overrides. Every member reads and changes them (the role matrix, src/workspaces/permissions.ts).
// Protected like every workspace route (src/workspaces/access-runtime.ts). The logic is in
// src/review-settings/http.ts.
import { connection } from "next/server";
import { createReviewSettingsRouteHandlers } from "@/review-settings/http";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import { withWorkspace } from "@/workspaces/access-runtime";
import type { WorkspaceAction } from "@/workspaces/permissions";

type Context =
  RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/project/settings">;

async function run(
  context: Context,
  action: WorkspaceAction,
  call: (
    handlers: ReturnType<typeof createReviewSettingsRouteHandlers>,
    repositoryId: string,
  ) => Promise<Response>,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, action, (access) =>
    call(
      createReviewSettingsRouteHandlers({
        requireUser: () => Promise.resolve(access.user),
        service: reviewSettingsServiceFor(access.workspace.id),
      }),
      repositoryId,
    ),
  );
}

export function GET(request: Request, context: Context): Promise<Response> {
  return run(context, "view", (handlers, id) =>
    handlers.getProject(request, id),
  );
}

export function PUT(request: Request, context: Context): Promise<Response> {
  return run(context, "change_project_settings", (handlers, id) =>
    handlers.putProject(request, id),
  );
}

export function DELETE(request: Request, context: Context): Promise<Response> {
  return run(context, "change_project_settings", (handlers, id) =>
    handlers.deleteProject(request, id),
  );
}
