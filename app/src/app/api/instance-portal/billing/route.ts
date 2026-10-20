// SPDX-License-Identifier: Apache-2.0

// GET|PUT /api/admin/billing: the billing settings of the instance (the adapter, the Stripe credentials, the rates and numbers
// and the switch), for the instance admin only. Not signed in is 401, signed in but not an admin is a 404
// (src/admin/access.ts); the proxy has done that first and the handlers do it again before anything is read. The logic is in
// src/billing/admin-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createBillingRouteHandlers } from "@/billing/admin-http";
import {
  getBillingAdminService,
  getBillingCreditService,
} from "@/billing/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createBillingRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getBillingAdminService(),
    credit: getBillingCreditService(),
  });
}

export async function GET(request: Request): Promise<Response> {
  return (await handlers()).get(request);
}

export async function PUT(request: Request): Promise<Response> {
  return (await handlers()).put(request);
}
