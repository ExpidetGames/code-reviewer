// `password_reset_tokens`: single-use links that let somebody set a new password (docs/decisions/0001-
// editions-setup-and-accounts.md, sections 2.3 and 2.7). The token is 256 random bits and travels in
// the link only; the table keeps its SHA-256 hash (`token_hash`), so a copy of the database cannot be
// used to reset a password. A token expires after 30 minutes (`expires_at`) and is used once
// (`used_at`). A row goes with its user.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("password_reset_tokens")
      .addColumn("token_hash", "text", (column) => column.primaryKey())
      .addColumn("user_id", "text", (column) =>
        column.notNull().references("users.id").onDelete("cascade"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("used_at", "text")
      .execute();

    // "Which tokens does this user have?" (a new link replaces the unused ones).
    await db.schema
      .createIndex("password_reset_tokens_user")
      .on("password_reset_tokens")
      .column("user_id")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("password_reset_tokens").execute();
  },
};
