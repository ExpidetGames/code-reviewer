// SPDX-License-Identifier: Apache-2.0

// GET /api/admin/catalog-providers (#554): the providers of the models.dev catalog with the state of their addresses.
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

export async function GET(request: Request): Promise<Response> {
  return (await handlers()).providers(request);
}
