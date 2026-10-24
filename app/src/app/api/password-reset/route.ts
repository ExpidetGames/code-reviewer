// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/password-reset: sets a new password with a reset link. Public on purpose (the token in the
// link is the credential, see src/auth/password-reset-http.ts). The command `admin reset-password` and,
// later, the reset mail make the links.
import { connection } from "next/server";
import { getPasswordResetHandler } from "@/auth/password-reset-runtime";

export async function POST(request: Request): Promise<Response> {
  await connection();
  return getPasswordResetHandler()(request);
}
