// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/admin/integrations/sync: reads the installations and repositories from GitHub now (the "Sync from
// GitHub" button), for the instance admin only. Not signed in is 401, signed in but not an admin is a 404
// (src/admin/access.ts); the proxy has done that first and the handlers do it again before anything is
// read. The synchronization is the instance's: it reads every connection of the instance and answers with
// instance-wide counts and the problems of every installation, which is not for the member of one
// workspace (binding an installation to a workspace is the job of the GitHub installation issue). The logic
// is in src/integrations/sync/http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { createAdminRouteHandlers } from "@/admin/http";
import { lookupAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { getIntegrationSync } from "@/integrations/sync/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createAdminRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read or synchronized.
    access: lookupAdmin,
    notFound,
    service: getAdminService(),
    // The process-wide service, never a new one: it holds the lock that keeps overlapping syncs apart.
    sync: getIntegrationSync,
  }).syncIntegrations(request);
}
