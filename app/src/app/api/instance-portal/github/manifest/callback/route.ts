// SPDX-License-Identifier: Apache-2.0

// GET /api/admin/github/manifest/callback: where GitHub sends the browser back after the App was created,
// with a one-time code and the state it was given. The state must be signed, unused, unexpired and bound to
// this admin and this session before the code is exchanged, once, for the App's credentials. Answers a
// redirect to the integrations page. The instance admin only; the logic is in src/github-config/service.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin, lookupSessionId } from "@/admin/session";
import { createGithubRouteHandlers } from "@/github-config/http";
import { getGithubConfigService } from "@/github-config/shared";

export async function GET(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createGithubRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    sessionId: lookupSessionId,
    notFound,
    service: getGithubConfigService(),
  }).manifestCallback(request);
}
