// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/billing/webhook-endpoint: makes sure the webhook endpoint of this app exists at Stripe and its signing
// secret is stored (creates it, or adopts the one that exists), for the instance admin only. The logic is in
// src/billing/admin-http.ts.
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
  }).webhookEndpoint(request);
}
