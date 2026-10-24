// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/setup/code: exchanges the setup code for a setup session. Public on purpose (the code is
// the credential) and present only while the instance is not set up: the setup gate in src/proxy.ts
// answers 404 afterwards, and the handler checks again. The logic is in src/setup/http.ts.
import { connection } from "next/server";
import { getSetupRouteHandlers } from "@/setup/shared";

export async function POST(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return getSetupRouteHandlers().submitCode(request);
}
