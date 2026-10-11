// SPDX-License-Identifier: Apache-2.0

// Where the login form sends a person who just signed in with email and password. Somebody who still has
// to verify the address, or who belongs to no workspace, is sent straight to the page that says so. The
// proxy would turn them away from the start page anyway, but a redirect by the proxy during the navigation
// that follows a Server Function leaves the address bar on the page they came from, so the destination is
// chosen here and the address is right.
import type { AccessGates } from "./access-gates.ts";
import { gateOf, NO_ACCESS_PAGE, VERIFY_EMAIL_PAGE } from "./session-user.ts";

export async function pathAfterPasswordSignIn(
  account: { id: string; emailVerified: boolean; isInstanceAdmin: boolean },
  gates: AccessGates,
): Promise<string> {
  switch (await gateOf(account, gates)) {
    case "unverified":
      return VERIFY_EMAIL_PAGE;
    case "no_workspace":
      return NO_ACCESS_PAGE;
    case null:
      return "/";
  }
}
