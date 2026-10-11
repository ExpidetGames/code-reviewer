// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/integrations/sync: reads the installations and repositories from GitHub now (the
// "Sync from GitHub" button). Connections are managed by Admins and Owners of the workspace. Protected like
// every workspace route (src/workspaces/access-runtime.ts). The logic is in src/integrations/sync/http.ts.
//
// The synchronization itself is the process-wide one and reads every connection of the instance (the
// start-up sync and the webhooks use the same service); binding an installation to the workspace of the
// person who installed it is the job of the GitHub installation issue.
import { connection } from "next/server";
import { createSyncRouteHandler } from "@/integrations/sync/http";
import { getIntegrationSync } from "@/integrations/sync/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/integrations/sync">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    createSyncRouteHandler({
      requireUser: () => Promise.resolve(access.user),
      // The process-wide service, never a new one: it holds the lock that keeps overlapping syncs apart.
      sync: getIntegrationSync(),
    })(request),
  );
}
