// SPDX-License-Identifier: Apache-2.0

// `signed_states`: the single-use side of the signed `state` values that make a round trip through the
// browser and GitHub (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.4 and 2.9): the
// manifest flow that creates the GitHub App, and the authorization that links a GitHub identity to an
// account. The value that travels is signed (src/crypto/sign.ts) and names a random nonce; the nonce is
// the row's id, and a state is accepted only if its row exists, has not expired and is used by one guarded
// statement, so it works once however many instances serve the callback. `user_id` and `session_hash` bind
// the state to the person and the browser session that started it. `code_verifier` is the PKCE secret of an
// authorization that was started here, kept server side; `data` is JSON that belongs to the flow and is
// handed back when the state is used (never a secret). A row goes with its user.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("signed_states")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("purpose", "text", (column) => column.notNull())
      .addColumn("user_id", "text", (column) =>
        column.references("users.id").onDelete("cascade"),
      )
      .addColumn("session_hash", "text")
      .addColumn("code_verifier", "text")
      .addColumn("data", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("used_at", "text")
      .execute();

    // The clean-up removes what has expired.
    await db.schema
      .createIndex("signed_states_expires")
      .on("signed_states")
      .column("expires_at")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("signed_states").execute();
  },
};
