// What the server checks about sign in when it starts: the settings must be complete, otherwise
// every page would fail later with a less helpful message. Called from `src/instrumentation.ts`.
import { isAccessConfigured } from "./access-config.ts";
import { AuthConfigError, loadAuthConfig } from "./config.ts";

type StartOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  exit?: (code: number) => void;
};

const NOBODY_ALLOWED_WARNING =
  "[auth] ACCESS_LIST_EMPTY: neither ALLOWED_GITHUB_LOGINS nor ALLOWED_GITHUB_ORG is set, so nobody is allowed to sign in. Set one of them to let people in.";

// The entries are public GitHub names (or typos of them), shortened so that nothing else that was
// pasted into the variable ends up in the log.
function invalidEntriesWarning(entries: readonly string[]): string {
  const shown = entries
    .slice(0, 3)
    .map((entry) => JSON.stringify(entry.slice(0, 20)))
    .join(", ");
  return `[auth] ACCESS_LIST_ENTRY_INVALID: ${String(entries.length)} entr${entries.length === 1 ? "y" : "ies"} of ALLOWED_GITHUB_LOGINS cannot be a GitHub login and will match nobody (${shown}). A login has only letters, digits and hyphens, without an @.`;
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
    if (odd.length > 0) warn(invalidEntriesWarning(odd));
  } catch (error) {
    if (!(error instanceof AuthConfigError)) throw error;
    log(`[auth] ${error.code}: ${error.message}`);
    exit(1);
  }
}
