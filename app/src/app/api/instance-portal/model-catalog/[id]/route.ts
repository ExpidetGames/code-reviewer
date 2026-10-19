// SPDX-License-Identifier: Apache-2.0

// PUT|DELETE /api/admin/model-catalog/:id (#429): changes an entry (the model behind a released entry only with a confirmation), deletes a draft.
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

export async function PUT(
  request: Request,
  context: RouteContext<"/api/instance-portal/model-catalog/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return (await handlers()).update(request, id);
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/instance-portal/model-catalog/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return (await handlers()).remove(request, id);
}
