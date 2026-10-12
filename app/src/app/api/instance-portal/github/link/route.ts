// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/github/link: starts the linking of the admin's own GitHub account to the admin account (and
// so the merge with an imported operator who has that GitHub account, src/github-signin/merge.ts) and
// answers the address of GitHub's authorization page. The instance admin only, also while the admin's
// address is not verified: the portal is where such a problem is repaired.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin, lookupSessionId } from "@/admin/session";
import { createGithubRouteHandlers } from "@/github-config/http";
import { getGithubConfigService } from "@/github-config/shared";
import { getGithubLinkService } from "@/github-signin/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createGithubRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    sessionId: lookupSessionId,
    notFound,
    service: getGithubConfigService(),
    link: getGithubLinkService(),
  }).startLink(request);
}
