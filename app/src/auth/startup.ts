// What the server checks about sign in when it starts: the settings must be complete, otherwise
// every page would fail later with a less helpful message. Called from `src/instrumentation.ts`.
import type { Kysely } from "kysely";
import { createAllowedLoginPinsRepository } from "../db/repositories/allowed-login-pins-repository.ts";
import type { Database } from "../db/schema.ts";
import { isAccessConfigured, type AccessConfig } from "./access-config.ts";
import { AuthConfigError, loadAuthConfig } from "./config.ts";

type StartOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  exit?: (code: number) => void;
};

const NOBODY_ALLOWED_WARNING =
  "[auth] ACCESS_LIST_EMPTY: neither ALLOWED_GITHUB_LOGINS nor ALLOWED_GITHUB_ORG is set, so nobody is allowed to sign in. Set one of them to let people in.";

// The plain entries are public GitHub names (or typos of them), shortened so that nothing else that
// was pasted into the variable ends up in the log. An entry of the form `login:id` that is not valid
// is only counted: it contains an id, and no id is ever printed.
function invalidEntriesWarning(
  entries: readonly string[],
  invalidPresets: number,
): string {
  const parts: string[] = [];
  if (entries.length > 0) {
    const shown = entries
      .slice(0, 3)
      .map((entry) => JSON.stringify(entry.slice(0, 20)))
      .join(", ");
    parts.push(
      `${String(entries.length)} entr${entries.length === 1 ? "y" : "ies"} cannot be a GitHub login (${shown}); a login has only letters, digits and hyphens, without an @`,
    );
  }
  if (invalidPresets > 0)
    parts.push(
      `${String(invalidPresets)} login:id entr${invalidPresets === 1 ? "y is" : "ies are"} not valid (the id is 1 to 20 digits without a leading zero, the login has no colon) or contradict${invalidPresets === 1 ? "s" : ""} another one`,
    );
  return `[auth] ACCESS_LIST_ENTRY_INVALID: in ALLOWED_GITHUB_LOGINS ${parts.join("; ")}. Such entries are ignored and admit nobody.`;
}

/**
 * An invalid configuration ends the process with exit code 1 and one readable line (the error code
 * and the variable names), not a stack trace. Anything unexpected is rethrown unchanged. An empty
 * allow list is not an error (the server is safe: nobody gets in) but is worth one warning.
 */
export function checkAuthConfigOnStart({
  env = process.env,
  log = console.error,
  warn = console.warn,
  exit = (code) => process.exit(code),
}: StartOptions = {}): void {
  try {
    const config = loadAuthConfig(env);
    if (!isAccessConfigured(config.access)) warn(NOBODY_ALLOWED_WARNING);
    const odd = config.access.invalidLoginEntries;
    const oddPresets = config.access.invalidPresetEntries;
    if (odd.length > 0 || oddPresets > 0)
      warn(invalidEntriesWarning(odd, oddPresets));
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
 * once when the server starts, after the migrations: the pins of logins that are no longer on the
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
