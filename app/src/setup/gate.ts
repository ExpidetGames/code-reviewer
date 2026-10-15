// SPDX-License-Identifier: Apache-2.0

// The setup gate, as a pure decision: what to do with a request while the instance is, or is not,
// set up (docs/decisions/0001-editions-setup-and-accounts.md, section 2.2). The proxy
// (src/proxy.ts) applies it before the session check.
//
// Not set up:
// - `/api/health` and the framework's static files always pass;
// - the setup itself (`/setup`, `/api/setup/**`) passes;
// - on an existing installation the webhooks and the runner API pass too, so reviews keep running;
// - every other API route answers `503 setup_required`;
// - every other page shows the setup (the code form, or the wizard once the code was accepted),
//   served in place of the page that was asked for. A request that is not a page view (a form
//   post, a Server Function) is answered `503 setup_required` like an API route.
//
// Set up: the setup does not exist any more. `/setup` and `/api/setup/**` answer 404, and nothing
// else is touched.
import { SETUP_PAGE } from "./paths.ts";
import type { SetupState } from "./state.ts";

export type SetupGateDecision =
  | { kind: "pass" }
  | { kind: "not_found" }
  | { kind: "setup_required" }
  | { kind: "show_setup" };

function isPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

const SETUP_API = "/api/setup";

/** Paths that keep working on an existing installation while the setup is open. */
const EXISTING_INSTALLATION_PATHS = [
  "/api/webhooks",
  "/api/runners",
  "/api/workers",
] as const;

export function decideSetupGate({
  pathname,
  method,
  state,
}: {
  pathname: string;
  method: string;
  state: SetupState;
}): SetupGateDecision {
  if (pathname === "/api/health") return { kind: "pass" };

  if (state.kind === "completed")
    return pathname === SETUP_PAGE || isPath(pathname, SETUP_API)
      ? { kind: "not_found" }
      : { kind: "pass" };

  // The framework's own files (scripts and styles of the setup page).
  if (isPath(pathname, "/_next")) return { kind: "pass" };
  if (pathname === SETUP_PAGE || isPath(pathname, SETUP_API))
    return { kind: "pass" };

  if (
    state.kind === "existing" &&
    EXISTING_INSTALLATION_PATHS.some((path) => isPath(pathname, path))
  )
    return { kind: "pass" };

  if (pathname === "/api" || pathname.startsWith("/api/"))
    return { kind: "setup_required" };
  return method === "GET" || method === "HEAD"
    ? { kind: "show_setup" }
    : { kind: "setup_required" };
}
