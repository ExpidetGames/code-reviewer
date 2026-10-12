// SPDX-License-Identifier: Apache-2.0

// Gives an integration test its own real SQLite file: a copy of the migrated template built by the
// global setup. Every file lives in a fresh temporary directory, is never shared between tests or
// workers, and is removed after the test (so are connections opened through `track`).
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, inject } from "vitest";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  type SqliteDatabaseConfig,
} from "../db/config.ts";
import { openDatabase } from "../db/connection.ts";
import type { Database } from "../db/schema.ts";

export type TestDatabase = {
  db: Kysely<Database>;
  config: SqliteDatabaseConfig;
  /** The directory that holds the file; removed after the test. */
  directory: string;
};

const cleanups: Array<() => Promise<void>> = [];

/** Runs after every test by itself; exported so that a test can assert what it leaves behind. */
export async function cleanUpTestResources(): Promise<void> {
  // Newest first: connections are closed before the directory they live in is removed.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

afterEach(cleanUpTestResources);

/** Closes the connection after the test. Returns it for convenience. */
export function track<T extends Kysely<Database>>(db: T): T {
  cleanups.push(() => db.destroy());
  return db;
}

/** Runs `cleanup` after the test, before the databases and directories are removed. */
export function cleanUpAfterTest(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

/** An empty temporary directory, removed after the test. */
export async function createTestDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cr-db-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A migrated database in its own directory, opened through the production `openDatabase`. */
export async function createTestDatabase(
  options: { busyTimeoutMs?: number } = {},
): Promise<TestDatabase> {
  const directory = await createTestDirectory();
  const path = join(directory, "app.db");
  await copyFile(inject("dbTemplatePath"), path);

  const config = {
    driver: "sqlite" as const,
    path,
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  };
  return { db: track(openDatabase(config)), config, directory };
}
