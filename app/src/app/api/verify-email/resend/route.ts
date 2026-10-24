// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/verify-email/resend { email }: sends a new verification link. Public on purpose; the answer is
// the same for every address and the route is rate limited per address and for the whole instance
// (src/signup/http.ts).
import { connection } from "next/server";
import { getSignUpRouteHandlers } from "@/signup/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return getSignUpRouteHandlers().resend(request);
}
