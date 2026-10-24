// SPDX-License-Identifier: LicenseRef-Proprietary

// #428: which catalog entries a workspace on the operator's key may use (src/workspaces/README.md, "Entitlements";
// ADR 0005, 2.9). A nullable JSON text column `model_access` on `workspace_entitlements`: `{"catalogEntries":[...]}`,
// or NULL for every released entry. The default of the instance (`default_entitlements`) is a JSON value and needs no
// column.
//
// Forward-only and safe next to a previous release: the column is nullable without a default, so no existing row is
// touched and reads as "every released entry", an insert of an older app instance that does not name the column leaves
// it NULL, and that instance reads columns by name, so it never sees this one.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("workspace_entitlements")
      .addColumn("model_access", "text")
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("workspace_entitlements")
      .dropColumn("model_access")
      .execute();
  },
};
