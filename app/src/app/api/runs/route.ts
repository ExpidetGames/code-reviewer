// SPDX-License-Identifier: Apache-2.0

// GET /api/runs?repository=<id>&status=<status>: the list of runs the Runs page polls.
// Protected: the proxy asks for a session, and `requireUser()` (called by the handler) is the second
// guard. The logic is in src/runs/http.ts.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { createRunsRouteHandlers } from "@/runs/http";
import { getRunsService } from "@/runs/shared";

export async function GET(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createRunsRouteHandlers({
    // The second guard behind the proxy (src/auth/README.md): called first, before any data is read.
    requireUser: () => requireUser(),
    service: getRunsService(),
  }).list(request);
}
