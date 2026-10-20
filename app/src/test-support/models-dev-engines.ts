// SPDX-License-Identifier: Apache-2.0

// The two database engines a models.dev catalog test runs on (SQLite always; Postgres when TEST_DATABASE_URL is set,
// otherwise its cases are skipped), each with a migrated database.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "./postgres-test-database.ts";
import { createTestDatabase } from "./test-database.ts";

export type ModelsDevEngine = {
  name: "sqlite" | "postgres";
  skip: boolean;
  create: () => Promise<{ db: Kysely<Database> }>;
};

export const MODELS_DEV_ENGINES: ModelsDevEngine[] = [
  {
    name: "sqlite",
    skip: false,
    async create() {
      const { db } = await createTestDatabase();
      return { db };
    },
  },
  {
    name: "postgres",
    skip: !hasPostgres(),
    async create() {
      const { db } = await createPostgresTestDatabase({ poolMax: 6 });
      return { db };
    },
  },
];
