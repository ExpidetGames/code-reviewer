// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/password-reset/request { email }: asks for a reset link by mail. Public on purpose (the person
// has no session, that is why they ask); the answer is the same for every address and the route is a 404
// while the instance cannot send mail (see src/auth/password-reset-request-http.ts).
import { connection } from "next/server";
import { getPasswordResetRequestHandler } from "@/auth/password-reset-runtime";

export async function POST(request: Request): Promise<Response> {
  await connection();
  return getPasswordResetRequestHandler()(request);
}
