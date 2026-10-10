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
  } catch (error) {
    if (!(error instanceof AuthConfigError)) throw error;
    log(`[auth] ${error.code}: ${error.message}`);
    exit(1);
  }
}
