// SPDX-License-Identifier: Apache-2.0

// What the server checks about sign in when it starts: the settings must be complete, otherwise
// every page would fail later with a less helpful message. Called from `src/instrumentation.ts`.
import type { Kysely } from "kysely";
import {
  conflictingAppSecretWarning,
  legacyAppSecretWarning,
} from "../crypto/app-secret.ts";
import { createAllowedLoginPinsRepository } from "../db/repositories/allowed-login-pins-repository.ts";
import type { Database } from "../db/schema.ts";
import type { AccessConfig } from "./access-config.ts";
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

type SyncPinsOptions = {
  db: Kysely<Database>;
  config: AccessConfig;
  info?: (message: string) => void;
  log?: (message: string) => void;
  exit?: (code: number) => void;
};

/**
 * Brings the pins of the allow list (`allowed_login_pins`) in line with the configuration. Called
 * once when the server starts, after the migrations. Does nothing at all when no logins list is
 * configured (organization mode only): then the table is neither read nor written. Otherwise the pins of logins that are no longer on the
 * list are deleted (so removing a login and adding it again resets its pin), and an id given as
 * `login:id` is set, replacing a different pin. A login without an id is bound at its first sign in.
 * Nothing printed names a login or an id. A failure ends the start with exit code 1: a stale pin
 * must not outlive its entry unnoticed.
 */
export async function syncLoginPinsOnStart({
  db,
  config,
  info = console.info,
  log = console.error,
  exit = (code) => process.exit(code),
}: SyncPinsOptions): Promise<void> {
  // Without a logins list (organization mode only, or nothing configured) the pins are not this
  // run's business: nothing is read, written or deleted.
  if (config.logins.size === 0) return;
  const pins = createAllowedLoginPinsRepository(db);
  try {
    await pins.deleteUnlisted(config.logins);
    let replaced = 0;
    for (const [login, githubId] of config.presetIds)
      if ((await pins.set(login, githubId)) === "replaced") replaced += 1;
    if (replaced > 0)
      info(
        `[auth] LOGIN_PIN_PRESET_APPLIED: ${String(replaced)} id${replaced === 1 ? "" : "s"} given as login:id in ALLOWED_GITHUB_LOGINS replaced a different stored binding.`,
      );
  } catch {
    log(
      "[auth] LOGIN_PINS_SYNC_FAILED: could not update the stored GitHub ids of the allowed logins (table allowed_login_pins).",
    );
    exit(1);
  }
}
