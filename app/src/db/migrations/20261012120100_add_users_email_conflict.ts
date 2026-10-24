// SPDX-License-Identifier: LicenseRef-Proprietary

// `users.email_conflict`: the verified primary email of a user's GitHub account when another account
// already has it (docs/decisions/0001-editions-setup-and-accounts.md, section 2.5). An imported user's
// placeholder address is replaced by GitHub's verified primary address at their next GitHub sign in; when
// that address belongs to another account the placeholder stays, nothing is taken over or merged, and this
// column holds the address so that the user's profile and the instance admin can show a hint. Every
// sign in sets it or clears it. Null for everybody else.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("users")
      .addColumn("email_conflict", "text")
      .execute();
  },

  async down(db) {
    await db.schema.alterTable("users").dropColumn("email_conflict").execute();
  },
};
