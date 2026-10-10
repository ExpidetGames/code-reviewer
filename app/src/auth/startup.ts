// What the server checks about sign in when it starts: the settings must be complete, otherwise
// every page would fail later with a less helpful message. Called from `src/instrumentation.ts`.
import { AuthConfigError, loadAuthConfig } from "./config.ts";

type StartOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  log?: (message: string) => void;
  exit?: (code: number) => void;
};

/**
 * An invalid configuration ends the process with exit code 1 and one readable line (the error code
 * and the variable names), not a stack trace. Anything unexpected is rethrown unchanged.
 */
export function checkAuthConfigOnStart({
  env = process.env,
  log = console.error,
  exit = (code) => process.exit(code),
}: StartOptions = {}): void {
  try {
    loadAuthConfig(env);
  } catch (error) {
    if (!(error instanceof AuthConfigError)) throw error;
    log(`[auth] ${error.code}: ${error.message}`);
    exit(1);
  }
}
