// SPDX-License-Identifier: Apache-2.0

// GET|PUT /api/admin/settings: the instance settings, for the instance admin only. Not signed in is
// 401, signed in but not an admin is a 404 (src/admin/access.ts); the proxy has done that first and the
// handlers do it again before anything is read. The logic is in src/admin/http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { createAdminRouteHandlers } from "@/admin/http";
import { lookupAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { getIntegrationSync } from "@/integrations/sync/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createAdminRouteHandlers({
    // The second guard behind the proxy: called first, before any data is read.
    access: lookupAdmin,
    notFound,
    service: getAdminService(),
    sync: getIntegrationSync,
  });
}

export async function GET(request: Request): Promise<Response> {
  return (await handlers()).getSettings(request);
}

export async function PUT(request: Request): Promise<Response> {
  return (await handlers()).putSettings(request);
}
