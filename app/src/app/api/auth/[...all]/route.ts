// SPDX-License-Identifier: Apache-2.0

// Better Auth's HTTP interface: the email and password sign in (limited, see src/auth/sign-in-limit.ts),
// the GitHub sign in, its callback and sign out. Public (see
// src/auth/access.ts); what is reachable is limited in src/auth/http.ts.
import { connection } from "next/server";
import { getAuth } from "@/auth/auth";
import { handleAuthRequest } from "@/auth/http";
import { getSignInLimiter } from "@/auth/sign-in-runtime";

// Needs the database and the request, so it never runs at build time.
async function handle(request: Request): Promise<Response> {
  await connection();
  return handleAuthRequest(getAuth(), request, getSignInLimiter());
}

export { handle as GET, handle as POST };
