// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm setup-code`: makes the first-run setup code of a serverless deployment (#321). A server prints its
// code in its own log when it starts; a serverless instance has no log the operator reads and no memory
// the next request shares, so the operator makes the code here, with the database of the deployment, and
// the instances check it in the database (database-code-store.ts). Run it after `pnpm migrate`, from a
// terminal, with the same `APP_SECRET` as the deployment (the code is stored as a keyed hash of it):
//
//   APP_RUNTIME=serverless DATABASE_URL_MIGRATE=... APP_SECRET=... pnpm setup-code
//
// The code is printed to the output of that terminal and nowhere else: it refuses to print to something
// that is not a terminal (a build log, a pipe, a CI job) unless `--allow-pipe` says the operator knows where
// the output goes. It never writes the code to a log or the error output, and an error is one line with a
// stable code that never repeats the cause (which could carry a connection string). Running it again
// replaces the code (and ends a setup session that was open). It refuses on an instance that is set up.
//
// Runs under plain Node (`node --conditions=react-server`, see package.json), like `pnpm migrate`.
import type { Kysely } from "kysely";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { loadMigrationDatabaseConfig } from "../db/config.ts";
import { DatabaseError } from "../db/errors.ts";
import {
  assertPostgresReachable,
  openPostgresDatabase,
} from "../db/postgres.ts";
import { readSchemaStatus } from "../db/schema-status.ts";
import type { Database } from "../db/schema.ts";
import { resolveRuntimeMode, RuntimeConfigError } from "../runtime/mode.ts";
import {
  createDatabaseSetupCodeStore,
  type IssuedSetupCode,
} from "./database-code-store.ts";
import { SETUP_CODE_TTL_MS } from "./code-store.ts";
import { readSetupState } from "./state.ts";

export const SETUP_CODE_CLI_ERROR_CODES = [
  "SETUP_CODE_NOT_SERVERLESS",
  "SETUP_CODE_CONFIG_INVALID",
  "SETUP_CODE_NOT_A_TERMINAL",
  "SETUP_CODE_SCHEMA_BEHIND",
  "SETUP_ALREADY_DONE",
  "SETUP_CODE_FAILED",
] as const;
export type SetupCodeCliErrorCode = (typeof SETUP_CODE_CLI_ERROR_CODES)[number];

type Env = Readonly<Record<string, string | undefined>>;
type Io = { out: (line: string) => void; err: (line: string) => void };

/** What the command needs from the database; the real one is `createSetupCodeBackend`. */
export type SetupCodeBackend = {
  /** Whether every migration of this version has run (the table exists). */
  schemaCurrent(): Promise<boolean>;
  /** Whether the first-run setup is complete. */
  isSetUp(): Promise<boolean>;
  /** Makes the code, replacing the old one. */
  issue(): Promise<IssuedSetupCode>;
  close(): Promise<void>;
};

export type SetupCodeOptions = {
  /** Whether the output of this process is a terminal. */
  isTerminal: boolean;
  /** The operator accepts that the output may not be a terminal. */
  allowPipe: boolean;
  /** Opens the database; tests pass a stand-in. */
  open?: (env: Env, appSecret: string) => Promise<SetupCodeBackend>;
};

export function createSetupCodeBackend(
  db: Kysely<Database>,
  appSecret: string,
): SetupCodeBackend {
  const store = createDatabaseSetupCodeStore({ db, appSecret });
  return {
    async schemaCurrent() {
      return (await readSchemaStatus(db)).upToDate;
    },
    async isSetUp() {
      return (await readSetupState(db)).kind === "completed";
    },
    issue: () => store.issue(),
    close: () => db.destroy(),
  };
}

async function openFromEnv(
  env: Env,
  appSecret: string,
): Promise<SetupCodeBackend> {
  const config = loadMigrationDatabaseConfig(env);
  const db = openPostgresDatabase(config);
  try {
    await assertPostgresReachable(db, config);
  } catch (error) {
    await db.destroy().catch(() => undefined);
    throw error;
  }
  return createSetupCodeBackend(db, appSecret);
}

function fail(io: Io, code: SetupCodeCliErrorCode, message: string): number {
  io.err(`[setup-code] ${code}: ${message}`);
  return 1;
}

/** Returns the exit code: 0 when a code was printed, 1 for a problem that was reported. */
export async function runSetupCodeCommand(
  env: Env,
  io: Io,
  options: SetupCodeOptions,
): Promise<number> {
  try {
    if (resolveRuntimeMode(env) !== "serverless")
      return fail(
        io,
        "SETUP_CODE_NOT_SERVERLESS",
        "this command is for APP_RUNTIME=serverless. A server prints its setup code in its own log when it starts. Set APP_RUNTIME=serverless for this command if the database is the one of a serverless deployment.",
      );
    const secret = resolveAppSecret(env);
    if (!secret.ok)
      return fail(io, "SETUP_CODE_CONFIG_INVALID", secret.problem);
    // Before anything is written: a code that may not be shown is not made.
    if (!options.isTerminal && !options.allowPipe)
      return fail(
        io,
        "SETUP_CODE_NOT_A_TERMINAL",
        "the output is not a terminal, and the code must not end up in a log. Run the command in a terminal, or add --allow-pipe if you know where the output goes.",
      );

    const backend = await (options.open ?? openFromEnv)(env, secret.secret);
    try {
      if (!(await backend.schemaCurrent()))
        return fail(
          io,
          "SETUP_CODE_SCHEMA_BEHIND",
          "the database is behind this version. Run pnpm migrate first.",
        );
      if (await backend.isSetUp())
        return fail(
          io,
          "SETUP_ALREADY_DONE",
          "this instance is already set up; there is no setup code to make.",
        );
      const issued = await backend.issue();
      io.out(`[setup-code] Setup code: ${issued.code}`);
      io.out(
        `[setup-code] Valid for ${String(SETUP_CODE_TTL_MS / 60_000)} minutes (until ${issued.expiresAt.toISOString()}). Open the app in a browser and enter it. Running this command again makes a new code and ends this one.`,
      );
      return 0;
    } finally {
      // Best effort: a failure to close must not hide the result.
      await backend.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof DatabaseError)
      return fail(io, "SETUP_CODE_FAILED", `${error.code}: ${error.message}`);
    if (error instanceof RuntimeConfigError)
      return fail(io, "SETUP_CODE_CONFIG_INVALID", error.message);
    // The cause is not repeated: it could carry a connection string or the code.
    return fail(
      io,
      "SETUP_CODE_FAILED",
      "the setup code could not be made. Check that DATABASE_URL_MIGRATE is a reachable, migrated database and run it again.",
    );
  }
}

// Runs only when started as the program, not when a test imports `runSetupCodeCommand`.
if (import.meta.main) {
  process.exitCode = await runSetupCodeCommand(
    process.env,
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    {
      isTerminal: process.stdout.isTTY === true,
      allowPipe: process.argv.includes("--allow-pipe"),
    },
  );
}
