// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/admin/llm-keys/:provider/test (#427): asks the provider whether the operator's key is accepted (the
// "Test" button of the admin page "LLM keys"), with the key typed into the field or, when it is empty, the stored one.
// For the instance admin only. Not signed in is 401, signed in but not an admin is a 404 (src/admin/access.ts); the
// proxy has done that first and the handlers do it again before anything is read or sent. The provider's address is
// its own API and nothing from the request. Limited per admin and for the instance, with counters of its own
// (src/llm/operator-key-test.ts). The logic is in src/admin/http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { createAdminRouteHandlers } from "@/admin/http";
import { lookupAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { getIntegrationSync } from "@/integrations/sync/shared";

export async function POST(
  request: Request,
  context: RouteContext<"/api/instance-portal/llm-keys/[provider]/test">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { provider } = await context.params;
  return createAdminRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read or sent.
    access: lookupAdmin,
    notFound,
    service: getAdminService(),
    sync: getIntegrationSync,
  }).testLlmKey(request, provider);
}
