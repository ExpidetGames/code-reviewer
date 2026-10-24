// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/admin/github/check: asks GitHub what the configured App is granted and answers the permissions
// it lacks of the ones the manifest asks for. The instance admin only; limited per admin and for the
// instance (src/github-config/service.ts).
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin, lookupSessionId } from "@/admin/session";
import { createGithubRouteHandlers } from "@/github-config/http";
import { getGithubConfigService } from "@/github-config/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createGithubRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    sessionId: lookupSessionId,
    notFound,
    service: getGithubConfigService(),
  }).check(request);
}
