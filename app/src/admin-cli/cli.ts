// The command line for the operator of an instance, run inside the app container:
//
//   admin reset-password <email>     print a single-use link that sets a new password (valid 30 minutes)
//
// (`admin` is a small wrapper the image puts on the PATH; without it: `node admin-cli/cli.ts ...`.)
// It is how a lost admin password is recovered when no mail server is configured; with one, the normal
// reset mail does the same. Exit code 0 on success, 1 when it could not be done (the reason is one line
// on stderr: a stable code and a sentence), 2 for a wrong command line. The output holds the link (that
// is the point), the address and the time it expires; the database keeps only the hash of the token.
//
// Node runs this file as it is (TypeScript types are stripped), without Next.js and without the app's
// other code: it imports only the files of this folder and better-sqlite3. That is why the image copies
// this folder as it is (app/Dockerfile).
import BetterSqlite3 from "better-sqlite3";
import { createResetLink } from "./reset-link.ts";

const DEFAULT_DATABASE_PATH = "/data/app.db";
const USAGE = "Usage: admin reset-password <email>";

type Streams = {
  out: (line: string) => void;
  err: (line: string) => void;
};

type Env = Readonly<Record<string, string | undefined>>;

export function runCli(
  args: readonly string[],
  env: Env,
  { out, err }: Streams,
  now: () => Date = () => new Date(),
): number {
  const [command, ...rest] = args;
  if (command === "reset-password" && rest.length === 1 && rest[0])
    return resetPassword(rest[0], env, { out, err }, now);
  err(USAGE);
  return 2;
}

function resetPassword(
  email: string,
  env: Env,
  { out, err }: Streams,
  now: () => Date,
): number {
  const baseUrl = env.BETTER_AUTH_URL?.trim();
  if (!baseUrl) {
    err(
      "[admin] PUBLIC_URL_MISSING: BETTER_AUTH_URL is not set, so the link has no address.",
    );
    return 1;
  }
  const path = env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
  let db: BetterSqlite3.Database;
  try {
    // The file must exist: a wrong path must not silently make an empty database.
    db = new BetterSqlite3(path, { fileMustExist: true, timeout: 5000 });
  } catch {
    err(`[admin] DATABASE_UNAVAILABLE: cannot open the database at ${path}.`);
    return 1;
  }
  try {
    const result = createResetLink(db, { email, baseUrl, now });
    if (!result.ok) {
      err(
        result.error === "unknown_account"
          ? "[admin] UNKNOWN_ACCOUNT: no account has this email address. Nothing was changed."
          : "[admin] NO_PASSWORD_ACCOUNT: this account has no password (it signs in with GitHub), so there is nothing to reset. Nothing was changed.",
      );
      return 1;
    }
    out(
      `Password reset link for ${email.trim().toLowerCase()}. It works once and expires at ${result.expiresAt} (30 minutes):`,
    );
    out(result.link);
    return 0;
  } catch (error) {
    // A locked or damaged database. The message may quote a path, never a token.
    err(
      `[admin] RESET_FAILED: the link could not be created (${error instanceof Error ? error.name : "error"}).`,
    );
    return 1;
  } finally {
    db.close();
  }
}

// Runs only when started as the program, not when a test imports `runCli`.
if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
