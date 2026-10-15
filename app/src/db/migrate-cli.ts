// SPDX-License-Identifier: Apache-2.0

// `pnpm migrate`: brings a Postgres database to the schema of this version, from outside the app. A
// serverless app never migrates by itself (every cold start of every instance would try, and a failing
// migration would end the function), so a deployment runs this first. It connects with
// `DATABASE_URL_MIGRATE`, a DIRECT connection (not a transaction pooler: a session advisory lock does
// not survive one), and holds the advisory lock for the whole run, so two deployments take turns. The
// second finds nothing left to do. A failure is a message and exit code 1, never a stack trace.
//
// Runs under plain Node (`node --conditions=react-server`, see package.json): the files it imports use
// relative paths, and `server-only` resolves to nothing under that condition.
import type { MigrationProvider } from "kysely/migration";
import { loadMigrationDatabaseConfig } from "./config.ts";
import { DatabaseError } from "./errors.ts";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";
import {
  assertPostgresReachable,
  openPostgresDatabase,
  withPostgresAdvisoryLock,
} from "./postgres.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Io = { out: (line: string) => void; err: (line: string) => void };

/** The advisory lock key of a migration run; deployments that run it share it. */
export const MIGRATE_LOCK_KEY = "code-reviewer:migrate";

/** Returns the exit code: 0 when the schema is current, 1 for a problem that was reported. */
export async function runMigrateCommand(
  env: Env,
  io: Io,
  options: { provider?: MigrationProvider } = {},
): Promise<number> {
  try {
    const config = loadMigrationDatabaseConfig(env);
    const db = openPostgresDatabase(config);
    try {
      await assertPostgresReachable(db, config);
      const { executed } = await withPostgresAdvisoryLock(
        db,
        MIGRATE_LOCK_KEY,
        () => migrateToLatest(db, options.provider ?? migrationProvider),
      );
      io.out(
        executed.length === 0
          ? "[migrate] the schema is up to date, nothing to apply."
          : `[migrate] applied ${String(executed.length)} migration(s): ${executed.join(", ")}`,
      );
      return 0;
    } finally {
      // Best effort: a failure to close must not hide the result.
      await db.destroy().catch(() => undefined);
    }
  } catch (error) {
    if (!(error instanceof DatabaseError)) throw error;
    io.err(`[migrate] ${error.code}: ${error.message}`);
    return 1;
  }
}

// Runs only when started as the program, not when a test imports `runMigrateCommand`.
if (import.meta.main) {
  process.exitCode = await runMigrateCommand(process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
