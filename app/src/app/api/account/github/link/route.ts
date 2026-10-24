// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/account/github/link: starts the linking of a GitHub account to the signed-in account (the "Link
// GitHub" button of the account page) and answers the address of GitHub's authorization page. Protected: the
// proxy asks for a session, and `requireUser()` (called by the handler) is the second guard. Limited per
// person and for the instance. The logic is in src/github-signin/link.ts.
import { connection } from "next/server";
import { lookupSessionId, requireUser } from "@/auth/session";
import { createStartLinkHandler } from "@/github-signin/link-http";
import { getGithubLinkService } from "@/github-signin/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createStartLinkHandler({
    // The second guard behind the proxy (src/auth/README.md): called first, before anything is read.
    requireUser: () => requireUser(),
    sessionId: lookupSessionId,
    service: getGithubLinkService(),
  })(request);
}
