// SPDX-License-Identifier: Apache-2.0

// GET|POST /api/admin/billing/plans (this file is below instance-portal; the proxy's /admin rewrite serves it at that public
// address): the plans of the billing module (#438), for the instance admin only. Not signed in is
// 401, signed in but not an admin is a 404 (src/admin/access.ts); the proxy has done that first and the handlers do it again
// before anything is read. While billing is off these routes are the 404 of a path that does not exist and read no billing
// table (src/billing/enabled.ts). The logic is in src/billing/plans-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createPlansRouteHandlers } from "@/billing/plans-http";
import { getBillingPlansService, isBillingOnNow } from "@/billing/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createPlansRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    isOn: isBillingOnNow,
    service: getBillingPlansService(),
  });
}

export async function GET(request: Request): Promise<Response> {
  return (await handlers()).get(request);
}

export async function POST(request: Request): Promise<Response> {
  return (await handlers()).create(request);
}
