// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /github/connected: the "Setup URL" of the GitHub App, where GitHub sends the browser after an installation
// (`?installation_id=&setup_action=&state=`). It is not a public path: the person has to be signed in, and the
// state is the one they started "Connect GitHub" with, in this browser session. It sends them on to GitHub's
// authorization, which gives the token that proves their rights, and the flow ends on a fixed page. The logic
// is in src/installation-binding/.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { getBindingRouteHandlers } from "@/installation-binding/shared";

export async function GET(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The second guard behind the proxy: somebody who is not signed in, or has to verify the address or has no
  // workspace, is sent where every page sends them, before anything of the flow is touched.
  await requireUser();
  return getBindingRouteHandlers().setupCallback(request);
}
