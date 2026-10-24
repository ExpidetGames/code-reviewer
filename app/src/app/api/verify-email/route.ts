// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/verify-email { token }: verifies the address a link was made for. Public on purpose (the token
// in the link is the credential); attempts are counted per link that exists (src/signup/http.ts).
import { connection } from "next/server";
import { getSignUpRouteHandlers } from "@/signup/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return getSignUpRouteHandlers().verify(request);
}
