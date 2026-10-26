// SPDX-License-Identifier: LicenseRef-Proprietary

// Gives an integration test its own real Postgres database: a copy of the migrated template that the global
// setup builds once per run (`create database ... template ...`). Every database is new, is never shared
// between tests or workers, and is dropped after the test (so are connections opened through `track`).
//
// A Postgres server is required: `TEST_DATABASE_URL` names it (CI starts a service container; locally, a
// throwaway container on a private port). Without the variable the default is the one of that container:
// postgres://postgres:postgres@127.0.0.1:5432/postgres. The tests fail, naming this, when the server is not
// there; they never skip.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, inject, vi } from "vitest";
import type { PostgresDatabaseConfig } from "../db/config.ts";
import { openPostgresDatabase } from "../db/postgres.ts";
import type { Database } from "../db/schema.ts";
import {
  adminPool,
  newDatabaseName,
  postgresTestUrl,
  withDatabase,
} from "./postgres-server.ts";

export {
  adminPool,
  DEFAULT_TEST_DATABASE_URL,
  newDatabaseName,
  postgresTestUrl,
  withDatabase,
} from "./postgres-server.ts";

export type TestDatabase = {
  db: Kysely<Database>;
  config: PostgresDatabaseConfig;
  /** The URL of this database alone. */
  url: string;
  /** The name of this database. */
  database: string;
  /** Drops the database; called automatically after the test. */
  drop: () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

/** Runs after every test by itself; exported so that a test can assert what it leaves behind. */
export async function cleanUpTestResources(): Promise<void> {
  // Newest first: connections are closed before the database they live in is dropped.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

afterEach(cleanUpTestResources);

/** Closes the connection after the test. Returns it for convenience. */
export function track<T extends Kysely<Database>>(db: T): T {
  cleanups.push(() => db.destroy().catch(() => undefined));
  return db;
}

/** Runs `cleanup` after the test, before the databases are dropped. */
export function cleanUpAfterTest(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

async function create(options: {
  template?: string;
  poolMax?: number;
}): Promise<TestDatabase> {
  const base = new URL(postgresTestUrl());
  const database = newDatabaseName();
  const admin = adminPool(base);
  try {
    await admin.query(
      options.template === undefined
        ? `create database "${database}"`
        : `create database "${database}" template "${options.template}"`,
    );
  } finally {
    await admin.end();
  }
  const url = withDatabase(base, database);
  const config: PostgresDatabaseConfig = {
    url,
    poolMax: options.poolMax ?? 4,
  };
  const db = openPostgresDatabase(config);
  const drop = async (): Promise<void> => {
    await db.destroy().catch(() => undefined);
    const closer = adminPool(base);
    // force: end any connection a leaked pool still holds, so the drop cannot hang.
    await closer.query(`drop database if exists "${database}" with (force)`);
    await closer.end();
  };
  cleanups.push(drop);
  return { db, config, url, database, drop };
}

/** A migrated database in its own right, opened through the production `openPostgresDatabase`. */
export function createTestDatabase(
  options: { poolMax?: number } = {},
): Promise<TestDatabase> {
  return create({ template: inject("dbTemplateName"), ...options });
}

/** An empty database (no migration ran), for a test that must watch or interrupt the migration itself. */
export function createEmptyTestDatabase(
  options: { poolMax?: number } = {},
): Promise<TestDatabase> {
  return create(options);
}

/** A second, independent connection to the same test database, for two-instance tests. */
export function connectPostgres(
  url: string,
  poolMax = 4,
): { db: Kysely<Database>; close: () => Promise<void> } {
  const db = openPostgresDatabase({ url, poolMax });
  const close = async (): Promise<void> => {
    await db.destroy().catch(() => undefined);
  };
  cleanUpAfterTest(close);
  return { db, close };
}

/**
 * For a test that calls a route file or a service through `getDatabase()`: a migrated database of its own is made
 * and `DATABASE_URL` points the process's connection at it (`vi.stubEnv`, undone by `vi.unstubAllEnvs`). A connection
 * left over from an earlier test is closed first.
 */
export async function openRouteTestDatabase(): Promise<TestDatabase> {
  const { closeDatabase } = await import("../db/startup.ts");
  await closeDatabase();
  const created = await createTestDatabase();
  vi.stubEnv("DATABASE_URL", created.url);
  cleanUpAfterTest(closeDatabase);
  return created;
}

/** An empty temporary directory, removed after the test. */
export async function createTestDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cr-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
