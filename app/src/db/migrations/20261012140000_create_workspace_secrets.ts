// SPDX-License-Identifier: Apache-2.0

// `workspace_secrets`: the encrypted credentials of ONE workspace (docs/decisions/0001-editions-setup-and-
// accounts.md, sections 2.7 and 2.8): today its own LLM key (name `llm_api_key`). One row per (workspace,
// name). Encrypted like the secrets of the instance (AES-256-GCM, a key derived from `APP_SECRET`); the table,
// the workspace id (the row id) and the name (the field) are bound into the ciphertext, so a row copied to
// another workspace or name does not decrypt. `binding` is what the secret was made for and must still match
// when it is used (the provider of an LLM key): a secret is never carried over to another provider or
// endpoint, the person enters it again. `last_four` is a non-secret display hint, stored only when the
// caller asks for it. A row goes with its workspace.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("workspace_secrets")
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id").onDelete("cascade"),
      )
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("binding", "text", (column) => column.notNull())
      .addColumn("ciphertext", "text", (column) => column.notNull())
      .addColumn("nonce", "text", (column) => column.notNull())
      .addColumn("key_version", "integer", (column) => column.notNull())
      .addColumn("last_four", "text")
      .addColumn("updated_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("workspace_secrets_pk", ["workspace_id", "name"])
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("workspace_secrets").execute();
  },
};
