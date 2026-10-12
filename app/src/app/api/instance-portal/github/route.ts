// SPDX-License-Identifier: Apache-2.0

// GET|PUT /api/admin/github: the GitHub integration of the instance, for the instance admin only (the
// App, its credentials and the sign in with GitHub). Not signed in is 401, signed in but not an admin is a
// 404 (src/admin/access.ts); the proxy has done that first and the handlers do it again before anything is
// read. The logic is in src/github-config/http.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin, lookupSessionId } from "@/admin/session";
import { createGithubRouteHandlers } from "@/github-config/http";
import { getGithubConfigService } from "@/github-config/shared";

async function handlers() {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return createGithubRouteHandlers({
    // The second guard behind the proxy: called first, before anything is read.
    access: lookupAdmin,
    sessionId: lookupSessionId,
    notFound,
    service: getGithubConfigService(),
  });
}

export async function GET(request: Request): Promise<Response> {
  return (await handlers()).get(request);
}

export async function PUT(request: Request): Promise<Response> {
  return (await handlers()).put(request);
}
