// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/billing/reviews/resolve: closes a billing review row with a required note and the admin as the actor,
// optionally after a manual credit or correction of the workspace of the row (once per row), for the instance admin only
// (#603). The logic is in src/billing/admin-http.ts and admin-review-service.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createBillingRouteHandlers } from "@/billing/admin-http";
import {
  getBillingAdminService,
  getBillingCreditService,
  getBillingReviewService,
} from "@/billing/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createBillingRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getBillingAdminService(),
    credit: getBillingCreditService(),
    reviews: getBillingReviewService(),
  }).resolveReview(request);
}
