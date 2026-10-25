// SPDX-License-Identifier: LicenseRef-Proprietary

// The database a billing test runs on (Postgres, see test-database.ts), with a migrated database for each case and the
// workspaces the cases write to.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { addWorkspace } from "./workspaces.ts";
import { createTestDatabase } from "./test-database.ts";

export type BillingEngine = {
  name: "postgres";
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
    name: "postgres",
    async create() {
      const { db } = await createTestDatabase({ poolMax: 12 });
      return withWorkspaces(db);
    },
  },
];
