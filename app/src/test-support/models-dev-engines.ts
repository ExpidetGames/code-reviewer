// SPDX-License-Identifier: LicenseRef-Proprietary

// The database a models.dev catalog test runs on (Postgres, see test-database.ts), a migrated one for each case.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { createTestDatabase } from "./test-database.ts";

export type ModelsDevEngine = {
  name: "postgres";
  create: () => Promise<{ db: Kysely<Database> }>;
};

export const MODELS_DEV_ENGINES: ModelsDevEngine[] = [
  {
    name: "postgres",
    async create() {
      const { db } = await createTestDatabase({ poolMax: 6 });
      return { db };
    },
  },
];
