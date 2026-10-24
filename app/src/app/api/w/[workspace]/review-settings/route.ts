// SPDX-License-Identifier: LicenseRef-Proprietary

// GET|PUT /api/w/:workspace/review-settings: the default values of the review settings of the workspace.
// Every member reads them; changing them needs an Admin or an Owner (they decide what every project of the
// workspace costs). Protected like every workspace route: the workspace is the one in the address, for a
// member only, and `withWorkspace` checks the role before anything is read. The logic is in
// src/review-settings/http.ts.
import { connection } from "next/server";
import { createReviewSettingsRouteHandlers } from "@/review-settings/http";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import { withWorkspace } from "@/workspaces/access-runtime";
import type { WorkspaceAction } from "@/workspaces/permissions";

type Context = RouteContext<"/api/w/[workspace]/review-settings">;

async function run(
  context: Context,
  action: WorkspaceAction,
  call: (
    handlers: ReturnType<typeof createReviewSettingsRouteHandlers>,
  ) => Promise<Response>,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, action, (access) =>
    call(
      createReviewSettingsRouteHandlers({
        requireUser: () => Promise.resolve(access.user),
        service: reviewSettingsServiceFor(access.workspace.id),
      }),
    ),
  );
}

export function GET(request: Request, context: Context): Promise<Response> {
  return run(context, "view", (handlers) => handlers.getGlobal(request));
}

export function PUT(request: Request, context: Context): Promise<Response> {
  return run(context, "manage_review_defaults", (handlers) =>
    handlers.putGlobal(request),
  );
}
