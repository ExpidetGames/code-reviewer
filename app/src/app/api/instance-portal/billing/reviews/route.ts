// SPDX-License-Identifier: Apache-2.0

// GET /api/admin/billing/reviews?state=&page=: the billing review rows (events that moved money and changed nothing in the
// ledger), open or resolved, newest first, 25 to a page, for the instance admin only (#603). Not signed in is 401, signed in
// but not an admin is a 404 (src/admin/access.ts); the proxy has done that first and the handlers do it again before anything
// is read. The logic is in src/billing/admin-http.ts and admin-review-service.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createBillingRouteHandlers } from "@/billing/admin-http";
import {
  getBillingAdminService,
  getBillingCreditService,
  getBillingReviewService,
} from "@/billing/shared";

export async function GET(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createBillingRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getBillingAdminService(),
    credit: getBillingCreditService(),
    reviews: getBillingReviewService(),
  }).reviews(request);
}
