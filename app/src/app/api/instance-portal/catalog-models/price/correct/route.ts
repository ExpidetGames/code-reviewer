// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/catalog-models/price/correct (#549): state the price of a catalog model, with a reason.
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

export async function POST(request: Request): Promise<Response> {
  return (await handlers()).correctPrice(request);
}
