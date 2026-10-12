// SPDX-License-Identifier: Apache-2.0

// POST /api/sign-up: creates an account with email and password when the sign-up rule lets the address in.
// Public on purpose (the visitor has no session yet); the answer never says whether an address has an
// account or is allowed, and the route is rate limited (src/signup/http.ts).
import { connection } from "next/server";
import { getSignUpRouteHandlers } from "@/signup/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return getSignUpRouteHandlers().signUp(request);
}
