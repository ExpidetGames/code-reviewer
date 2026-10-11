// Brings the database to the latest schema. All pending migrations run in one transaction (see
// dialect.ts): if one fails, nothing of the batch is applied or recorded, and the error names the
// migration. Two instances starting at once take turns on the write lock; the second finds nothing
// left to do.
import type { Kysely } from "kysely";
import { Migrator, type MigrationProvider } from "kysely/migration";
import { DatabaseError, describeError, errorCode } from "./errors.ts";
import { migrationProvider } from "./migrations/index.ts";

export type MigrationOutcome = {
  /** Names of the migrations this call applied, in order. Empty when the schema was current. */
  executed: string[];
};

export async function migrateToLatest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely types Migrator and migrations with Kysely<any>, because a migration must not depend on the current schema types.
  db: Kysely<any>,
  provider: MigrationProvider = migrationProvider,
): Promise<MigrationOutcome> {
  const { error, results = [] } = await new Migrator({
    db,
    provider,
  }).migrateToLatest();

  if (error) {
    const failed = results.find((result) => result.status === "Error");
    // No migration failed, the database was busy: another instance is still migrating (or holds a
    // write lock) for longer than the busy timeout. Nothing is broken; starting again will work.
    if (!failed && errorCode(error) === "SQLITE_BUSY") {
      throw new DatabaseError(
        "DATABASE_LOCKED",
        "The database is locked by another process for longer than the busy timeout, so the " +
          "migrations could not start. Nothing was changed. Is another instance still starting up? " +
          "Try again, or raise DATABASE_BUSY_TIMEOUT_MS.",
        { cause: error },
      );
    }
    const which = failed
      ? `Migration "${failed.migrationName}"`
      : "Running the migrations";
    throw new DatabaseError(
      "MIGRATION_FAILED",
      `${which} failed and was rolled back: ${describeError(error)}`,
      { cause: error },
    );
  }

  return {
    executed: results
      .filter((r) => r.status === "Success")
      .map((r) => r.migrationName),
  };
}
