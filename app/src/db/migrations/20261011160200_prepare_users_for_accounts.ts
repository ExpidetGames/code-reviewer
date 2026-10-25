// SPDX-License-Identifier: LicenseRef-Proprietary

// Prepares `users` for accounts that are not tied to GitHub (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.6 and 2.5):
//
// - `github_login` becomes optional: a user can exist without a GitHub account.
// - `imported_at` marks the users of an installation that existed before accounts were introduced
//   (set by the import of an existing installation, never by this migration); only they qualify for
//   the merge with the instance admin.
//
// SQLite cannot drop NOT NULL from a column, and `users` is referenced by `sessions` and `accounts`
// with ON DELETE CASCADE, so rebuilding the table would delete them. The column is replaced instead:
// add a nullable copy, copy the values, drop the old column, rename the copy.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("users")
      .addColumn("github_login_optional", "text")
      .execute();
    await sql`update users set github_login_optional = github_login`.execute(
      db,
    );
    await db.schema.alterTable("users").dropColumn("github_login").execute();
    await db.schema
      .alterTable("users")
      .renameColumn("github_login_optional", "github_login")
      .execute();
    await db.schema
      .alterTable("users")
      .addColumn("imported_at", "text")
      .execute();
  },
};
