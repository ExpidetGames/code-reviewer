// SPDX-License-Identifier: Apache-2.0

// Next.js runs this before every route. Two steps, in this order:
//
// 1. The setup gate (src/setup/gate.ts): while the instance is not set up, everything but the health
//    check, the static files and the setup itself waits for the first-run setup; once it is set up,
//    the setup does not exist any more (404).
// 2. The access check: nothing is reachable without a session except the paths in src/auth/access.ts.
//    The logic is in src/auth/access-proxy.ts so it can be tested without a server.
import type { NextRequest } from "next/server";
import { getAccessGates } from "./auth/access-gates-runtime.ts";
import { createAccessProxy } from "./auth/access-proxy.ts";
import { getAuth } from "./auth/auth.ts";
import { createSetupGate } from "./setup/gate-proxy.ts";
import { getSetupStateReader } from "./setup/shared.ts";

const setupGate = createSetupGate({
  // Per request, so the reader is created on first use (not when the module is loaded).
  readState: () => getSetupStateReader()(),
});

const accessProxy = createAccessProxy({
  getAuth,
  getGates: getAccessGates,
});

export async function proxy(request: NextRequest) {
  const gated = await setupGate(request);
  if (gated !== undefined) return gated;
  return accessProxy(request);
}

export const config = {
  // Everything except Next.js's own static files; "default deny" depends on this matching all.
  matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"],
};
