// The four tables Better Auth reads and writes through its Kysely adapter (users, sessions,
// accounts, verifications), with the names and columns that src/auth/auth.ts maps its model to.
// `users.github_login` is our own column: the current GitHub login, refreshed on every sign in.
// `accounts` holds the GitHub identity: provider_id "github" and account_id = the numeric GitHub id.
// `src/auth/schema-drift.integration.test.ts` fails when this migration and Better Auth's idea of
// the schema ever disagree.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("users")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("email", "text", (column) => column.notNull().unique())
      .addColumn("email_verified", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("image", "text")
      .addColumn("github_login", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("sessions")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("token", "text", (column) => column.notNull().unique())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("ip_address", "text")
      .addColumn("user_agent", "text")
      .addColumn("user_id", "text", (column) =>
        column.notNull().references("users.id").onDelete("cascade"),
      )
      .execute();
    await db.schema
      .createIndex("sessions_user_id_index")
      .on("sessions")
      .column("user_id")
      .execute();

    await db.schema
      .createTable("accounts")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("account_id", "text", (column) => column.notNull())
      .addColumn("provider_id", "text", (column) => column.notNull())
      .addColumn("user_id", "text", (column) =>
        column.notNull().references("users.id").onDelete("cascade"),
      )
      .addColumn("access_token", "text")
      .addColumn("refresh_token", "text")
      .addColumn("id_token", "text")
      .addColumn("access_token_expires_at", "text")
      .addColumn("refresh_token_expires_at", "text")
      .addColumn("scope", "text")
      .addColumn("password", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
    await db.schema
      .createIndex("accounts_user_id_index")
      .on("accounts")
      .column("user_id")
      .execute();

    await db.schema
      .createTable("verifications")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("identifier", "text", (column) => column.notNull())
      .addColumn("value", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
    await db.schema
      .createIndex("verifications_identifier_index")
      .on("verifications")
      .column("identifier")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("verifications").execute();
    await db.schema.dropTable("accounts").execute();
    await db.schema.dropTable("sessions").execute();
    await db.schema.dropTable("users").execute();
  },
};
