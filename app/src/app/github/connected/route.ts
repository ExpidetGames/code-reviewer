// SPDX-License-Identifier: Apache-2.0

// GET /github/connected: the "Setup URL" of the GitHub App, where GitHub sends the browser after an installation
// (`?installation_id=&setup_action=&state=`). It is not a public path: the person has to be signed in, and the
// state is the one they started "Connect GitHub" with, in this browser session. It sends them on to GitHub's
// authorization, which gives the token that proves their rights, and the flow ends on a fixed page. The logic
// is in src/installation-binding/.
import { connection } from "next/server";
import { getBindingRouteHandlers } from "@/installation-binding/shared";

export async function GET(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  return getBindingRouteHandlers().setupCallback(request);
}
