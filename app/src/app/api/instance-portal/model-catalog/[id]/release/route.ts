// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/admin/model-catalog/:id/release (#429): draft or retired to released, after the provider's metadata vouches for the model.
// For the instance admin only. Not signed in is 401, signed in but not an admin is a 404 (src/admin/access.ts); the
// proxy has done that first and the handlers do it again before anything is read. The logic is in
// src/model-catalog/admin-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createCatalogRouteHandlers } from "@/model-catalog/admin-http";
import { getCatalogAdminService } from "@/model-catalog/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createCatalogRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getCatalogAdminService(),
  });
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/instance-portal/model-catalog/[id]/release">,
): Promise<Response> {
  const { id } = await context.params;
  return (await handlers()).release(request, id);
}
