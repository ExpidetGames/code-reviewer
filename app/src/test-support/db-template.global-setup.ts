// SPDX-License-Identifier: LicenseRef-Proprietary

// Vitest global setup of the integration project: builds the migrated template database once per run. Every
// test then clones it (see test-database.ts) instead of migrating again.
import type { TestProject } from "vitest/node";
import { migrateToLatest } from "../db/migrate.ts";
import { openPostgresDatabase } from "../db/postgres.ts";
import {
  adminPool,
  newDatabaseName,
  postgresTestUrl,
  withDatabase,
} from "./postgres-server.ts";

declare module "vitest" {
  export interface ProvidedContext {
    dbTemplateName: string;
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const base = new URL(postgresTestUrl());
  const template = newDatabaseName("cr_template");
  const admin = adminPool(base);
  try {
    await admin.query(`create database "${template}"`);
  } catch (cause) {
    await admin.end();
    throw new Error(
      "The integration tests need a Postgres server (TEST_DATABASE_URL, or postgres://postgres:postgres@127.0.0.1:5432/postgres). " +
        `Start one (see TESTING.md). ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  await admin.end();

  const db = openPostgresDatabase({
    url: withDatabase(base, template),
    poolMax: 2,
  });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }

  project.provide("dbTemplateName", template);
  return async () => {
    const closer = adminPool(base);
    await closer.query(`drop database if exists "${template}" with (force)`);
    await closer.end();
  };
}
