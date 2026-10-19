// SPDX-License-Identifier: Apache-2.0

// The two database engines a billing test runs on (SQLite always; Postgres when TEST_DATABASE_URL is set, otherwise its
// cases are skipped), with a migrated database each and the one workspace the cases write to.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "./postgres-test-database.ts";
import { createTestDatabase } from "./test-database.ts";
import { addWorkspace } from "./workspaces.ts";

export type BillingEngine = {
  name: "sqlite" | "postgres";
  /** Postgres cases are skipped without TEST_DATABASE_URL. */
  skip: boolean;
  /** A migrated database with two workspaces, `a` and `b`. */
  create: () => Promise<{
    db: Kysely<Database>;
    workspaceId: string;
    otherWorkspaceId: string;
  }>;
};

async function withWorkspaces(db: Kysely<Database>) {
  return {
    db,
    workspaceId: await addWorkspace(db, "billing-a"),
    otherWorkspaceId: await addWorkspace(db, "billing-b"),
  };
}

export const BILLING_ENGINES: BillingEngine[] = [
  {
    name: "sqlite",
    skip: false,
    async create() {
      const { db } = await createTestDatabase({ busyTimeoutMs: 20_000 });
      return withWorkspaces(db);
    },
  },
  {
    name: "postgres",
    skip: !hasPostgres(),
    async create() {
      const { db } = await createPostgresTestDatabase({ poolMax: 12 });
      return withWorkspaces(db);
    },
  },
];
