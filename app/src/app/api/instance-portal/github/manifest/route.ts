// SPDX-License-Identifier: Apache-2.0

// POST /api/admin/github/manifest: starts the manifest flow that creates the GitHub App. Answers the
// manifest and the address of GitHub's creation page (with a signed, single-use state bound to the admin's
// session in it), which the browser posts to GitHub. The instance admin only; the logic is in
// src/github-config/service.ts.
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
  }).startManifest(request);
}
