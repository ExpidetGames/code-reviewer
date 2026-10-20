// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/catalog-providers/url/confirm (#554): trust the new address of a provider, the one the admin saw.
// For the instance admin only. Not signed in is 401, signed in but not an admin is a 404 (src/admin/access.ts); the
// proxy has done that first and the handlers do it again before anything is read. The logic is in
// src/models-dev/admin-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createModelsDevRouteHandlers } from "@/models-dev/admin-http";
import { getModelsDevAdminService } from "@/models-dev/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createModelsDevRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getModelsDevAdminService(),
  });
}

export async function POST(request: Request): Promise<Response> {
  return (await handlers()).confirmUrl(request);
}
