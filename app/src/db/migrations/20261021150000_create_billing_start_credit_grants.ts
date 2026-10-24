// SPDX-License-Identifier: LicenseRef-Proprietary

// The memory of the start credit (ADR 0006, 2.16, D11; #507): one row for each GitHub account that was ever granted it. The
// start credit is tied to the account of the installation, not to the workspace, so deleting a workspace and creating it again,
// or binding a second workspace to the same account, never grants twice. The table is instance level and keeps a numeric
// account id, the id of the workspace that got the credit, and the time: no login, no name, no address.
//
// `workspace_id` has NO foreign key, on purpose: the memory has to outlive the workspace it names (a row that cascaded away
// with the workspace would let the account be granted again). The primary key on the account id is what makes the grant race
// safe: of two writers that insert the same account at the same moment exactly one wins. A check restates that an account id
// is a plain positive number (GitHub's numeric id, as text) so that nothing else, a login or an address, can be stored in it.
// New and empty and nothing existing is touched, so an app of the previous release keeps working on the same database. The
// check is written per engine because the pattern syntax differs; the columns and the key are the same.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

export const migration: Migration = {
  async up(db) {
    const digits =
      databaseDriver(db) === "postgres"
        ? sql`github_account_id ~ '^[1-9][0-9]{0,18}$'`
        : sql`github_account_id <> '' and github_account_id not glob '*[^0-9]*' and substr(github_account_id, 1, 1) <> '0' and length(github_account_id) <= 19`;
    await db.schema
      .createTable("billing_start_credit_grants")
      .addColumn("github_account_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      // Opaque and unchecked: the workspace may be gone.
      .addColumn("workspace_id", "text", (column) => column.notNull())
      .addColumn("granted_at", "text", (column) => column.notNull())
      .addCheckConstraint("billing_start_credit_grants_account_check", digits)
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("billing_start_credit_grants").execute();
  },
};
