// SPDX-License-Identifier: LicenseRef-Proprietary

// `secrets`: the credentials of the instance, encrypted at rest (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.7): the SMTP password, the GitHub App private key and the like. One row per
// secret `name`. The value is AES-256-GCM encrypted with a key derived from `APP_SECRET`; the table,
// the name (the row id) and the field are bound into the ciphertext, so a row copied to another name
// does not decrypt. `key_version` says which derived key made it, so a rotation can follow.
// `last_four` is a non-secret display hint (the last four characters), stored only for values where
// the caller asks for it and the value is long enough that four characters give nothing away.
// `updated_by` is the id of the admin who saved it; the user may be deleted later, the row stays.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("secrets")
      .addColumn("name", "text", (column) => column.primaryKey())
      .addColumn("ciphertext", "text", (column) => column.notNull())
      .addColumn("nonce", "text", (column) => column.notNull())
      .addColumn("key_version", "integer", (column) => column.notNull())
      .addColumn("last_four", "text")
      .addColumn("updated_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("secrets").execute();
  },
};
