// SPDX-License-Identifier: Apache-2.0

// GET /api/admin/catalog-models (#549): the models of the models.dev catalog with their price status, the admin's decisions and whether the managed key may use them.
// For the instance admin only. Not signed in is 401, signed in but not an admin is a 404 (src/admin/access.ts); the
// proxy has done that first and the handlers do it again before anything is read. The logic is in
// src/model-prices/admin-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createModelPriceRouteHandlers } from "@/model-prices/admin-http";
import { getModelPriceService } from "@/model-prices/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createModelPriceRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getModelPriceService(),
  });
}

export async function GET(request: Request): Promise<Response> {
  return (await handlers()).list(request);
}
