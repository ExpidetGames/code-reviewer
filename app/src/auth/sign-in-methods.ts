// SPDX-License-Identifier: Apache-2.0

// Which ways to sign in this instance offers. Email with password always exists (the instance admin
// signs in that way). GitHub exists while the GitHub OAuth app is configured. The admin portal will
// make this a setting (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3).
import { loadAuthConfig } from "./config.ts";

type Env = Readonly<Record<string, string | undefined>>;

export function githubSignInConfigured(env: Env): boolean {
  try {
    return loadAuthConfig(env).github.oauth !== null;
  } catch {
    // An invalid configuration stops the server at start; a page that is asked anyway offers nothing.
    return false;
  }
}
