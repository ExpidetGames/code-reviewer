// SPDX-License-Identifier: Apache-2.0

// Vitest global setup of the integration project: builds the migrated template database once per
// run. Every test then copies the file (see test-database.ts) instead of migrating again.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import type { TestProject } from "vitest/node";
import { openDatabase } from "../db/connection.ts";
import { migrateToLatest } from "../db/migrate.ts";

declare module "vitest" {
  export interface ProvidedContext {
    dbTemplatePath: string;
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "cr-db-template-"));
  const templatePath = join(directory, "template.db");

  const db = openDatabase({ path: templatePath, busyTimeoutMs: 5000 });
  await migrateToLatest(db);
  // Fold the write-ahead log into the main file so that copying that one file copies everything.
  await sql`pragma wal_checkpoint(truncate)`.execute(db);
  await db.destroy();

  project.provide("dbTemplatePath", templatePath);
  return () => rm(directory, { recursive: true, force: true });
}
