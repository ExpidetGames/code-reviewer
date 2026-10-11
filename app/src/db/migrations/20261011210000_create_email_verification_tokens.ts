// SPDX-License-Identifier: Apache-2.0

// `email_verification_tokens`: single-use links that verify an email address (docs/decisions/0001-
// editions-setup-and-accounts.md, sections 2.5 and 2.7). The token is 256 random bits and travels in the
// link only; the table keeps its SHA-256 hash (`token_hash`), so a copy of the database cannot verify an
// address. A token expires after 24 hours (`expires_at`) and is used once (`used_at`). It is bound to the
// address it was made for (`email`): if the address of the account is not that one any more, it verifies
// nothing. A row goes with its user.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("email_verification_tokens")
      .addColumn("token_hash", "text", (column) => column.primaryKey())
      .addColumn("user_id", "text", (column) =>
        column.notNull().references("users.id").onDelete("cascade"),
      )
      .addColumn("email", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("used_at", "text")
      .execute();

    // "Which tokens does this user have?" (a new link replaces the unused ones).
    await db.schema
      .createIndex("email_verification_tokens_user")
      .on("email_verification_tokens")
      .column("user_id")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("email_verification_tokens").execute();
  },
};
