// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/setup/complete: finishes the first-run setup (creates the instance admin and stores the
// choices). Public on purpose (the setup session from the code is the credential) and present only
// while the instance is not set up. The logic is in src/setup/http.ts.
import { connection } from "next/server";
import { getSetupRouteHandlers } from "@/setup/shared";

export async function POST(request: Request): Promise<Response> {
  await connection();
  return getSetupRouteHandlers().complete(request);
}
