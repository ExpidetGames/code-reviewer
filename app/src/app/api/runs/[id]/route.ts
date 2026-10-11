// GET /api/runs/:id: one run, as the detail page polls it while the run is waiting or running.
// Protected: the proxy asks for a session, and `requireUser()` (called by the handler) is the second
// guard. The logic is in src/runs/http.ts.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { createRunsRouteHandlers } from "@/runs/http";
import { getRunsService } from "@/runs/shared";

export async function GET(
  request: Request,
  context: RouteContext<"/api/runs/[id]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { id } = await context.params;
  return createRunsRouteHandlers({
    requireUser: () => requireUser(),
    service: getRunsService(),
  }).detail(request, id);
}
