// SPDX-License-Identifier: Apache-2.0

// Better Auth's HTTP interface: the email and password sign in (limited, see src/auth/sign-in-limit.ts),
// the GitHub sign in, its callback and sign out. Public (see
// src/auth/access.ts); what is reachable is limited in src/auth/http.ts.
import { connection } from "next/server";
import { getAuth } from "@/auth/auth";
import { getGithubAuth } from "@/auth/github-auth";
import { handleAuthRequest } from "@/auth/http";
import { getSignInLimiter, getSignInMethods } from "@/auth/sign-in-runtime";
import { getGithubLinkCallback } from "@/github-signin/shared";

// Needs the database and the request, so it never runs at build time.
async function handle(request: Request): Promise<Response> {
  await connection();
  // A callback whose state is one of ours completes the linking of a GitHub identity to the signed-in
  // account (src/github-signin/link.ts); everything else is Better Auth's.
  const linked = await getGithubLinkCallback()(request);
  if (linked !== null) return linked;
  return handleAuthRequest(
    getAuth(),
    request,
    getSignInLimiter(),
    getSignInMethods,
    getGithubAuth,
  );
}

export { handle as GET, handle as POST };
