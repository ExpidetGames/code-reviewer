// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/billing/notification-destination: creates the Paddle notification destination (this app's address
// plus /api/billing/webhook, with the events the app handles) and stores the secret Paddle returns, for the instance
// admin only. The logic is in src/billing/admin-http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createBillingRouteHandlers } from "@/billing/admin-http";
import { getBillingSettingsService } from "@/billing/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createBillingRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    notFound,
    service: getBillingSettingsService(),
  }).createNotificationDestination(request);
}
