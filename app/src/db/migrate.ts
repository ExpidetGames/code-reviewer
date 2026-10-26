// SPDX-License-Identifier: LicenseRef-Proprietary

// Brings the database to the latest schema. All pending migrations run in one transaction (Postgres has
// transactional DDL): if one fails, nothing of the batch is applied or recorded, and the error names the
// migration. Two runs at once take turns on the migration lock; the second finds nothing left to do.
import type { Kysely } from "kysely";
import { Migrator, type MigrationProvider } from "kysely/migration";
import { DatabaseError, describeError } from "./errors.ts";
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
