// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/admin/billing/reviews/check: "Check payment" for the top-up a billing review row belongs to, asked by the instance
// admin (#603): the payment provider is asked what became of the payment and the answer is applied like a webhook. The logic
// is in src/billing/admin-http.ts and admin-review-service.ts.
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
  }).checkReview(request);
}
