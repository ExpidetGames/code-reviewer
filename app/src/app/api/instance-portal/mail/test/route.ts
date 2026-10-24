// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/admin/mail/test: sends a test mail to the admin's own address with the saved mail server
// settings, for the instance admin only. Not signed in is 401, signed in but not an admin is a 404
// (src/admin/access.ts); the proxy has done that first and the handlers do it again before anything is
// read. Limited per admin and for the instance (src/mail/test-mail.ts). The logic is in src/admin/http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { createAdminRouteHandlers } from "@/admin/http";
import { lookupAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { getIntegrationSync } from "@/integrations/sync/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createAdminRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read or sent.
    access: lookupAdmin,
    notFound,
    service: getAdminService(),
    sync: getIntegrationSync,
  }).testMail(request);
}
