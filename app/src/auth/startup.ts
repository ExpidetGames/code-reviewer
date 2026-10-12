// SPDX-License-Identifier: Apache-2.0

// What the server checks about sign in when it starts: the settings must be complete, otherwise
// every page would fail later with a less helpful message. Called from `src/instrumentation.ts`.
import {
  conflictingAppSecretWarning,
  legacyAppSecretWarning,
} from "../crypto/app-secret.ts";
import { AuthConfigError, loadAuthConfig } from "./config.ts";

type StartOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  exit?: (code: number) => void;
};

/**
 * An invalid configuration ends the process with exit code 1 and one readable line (the error code
 * and the variable names), not a stack trace. Anything unexpected is rethrown unchanged. The master
 * key (`APP_SECRET`, or its deprecated name) and the public address are required. The sign in with
 * GitHub is configured in the admin portal, not here.
 */
export function checkAuthConfigOnStart({
  env = process.env,
  log = console.error,
  warn = console.warn,
  exit = (code) => process.exit(code),
}: StartOptions = {}): void {
  try {
    loadAuthConfig(env);
    // The old name of the master key still works; say once that it is on its way out.
    const deprecated = legacyAppSecretWarning(env);
    if (deprecated !== null) warn(deprecated);
    const conflict = conflictingAppSecretWarning(env);
    if (conflict !== null) warn(conflict);
  } catch (error) {
    if (!(error instanceof AuthConfigError)) throw error;
    log(`[auth] ${error.code}: ${error.message}`);
    exit(1);
  }
}
