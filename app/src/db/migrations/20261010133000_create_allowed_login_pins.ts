// SPDX-License-Identifier: Apache-2.0

// `allowed_login_pins`: which GitHub account (its numeric id) a login on `ALLOWED_GITHUB_LOGINS` is
// bound to. GitHub frees an old username after a rename, so a login alone is not an identity; the
// first account that signs in with a listed login is pinned (or an id is pre-set with
// `login:id`), and an account with the same login and another id is refused (src/auth/login-pins.ts).
// `login` is the lower-cased login; `pinned_at` is ISO 8601 text in UTC. Only listed logins get a
// row, and the server deletes the rows of logins that left the list when it starts.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("allowed_login_pins")
      .addColumn("login", "text", (column) => column.primaryKey())
      .addColumn("github_id", "text", (column) => column.notNull())
      .addColumn("pinned_at", "text", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("allowed_login_pins").execute();
  },
};
