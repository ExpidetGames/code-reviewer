// SPDX-License-Identifier: Apache-2.0

// POST /api/integrations/sync: reads the installations and repositories from GitHub now (the "Sync
// from GitHub" button). Protected: the proxy asks for a session, and `requireUser()` (called by the
// handler) is the second guard. The logic is in src/integrations/sync/http.ts.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { createSyncRouteHandler } from "@/integrations/sync/http";
import { getIntegrationSync } from "@/integrations/sync/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createSyncRouteHandler({
    // The second guard behind the proxy (src/auth/README.md): called first, before GitHub is asked.
    requireUser: () => requireUser(),
    // The process-wide service, never a new one: it holds the lock that keeps overlapping syncs apart.
    sync: getIntegrationSync(),
  })(request);
}
