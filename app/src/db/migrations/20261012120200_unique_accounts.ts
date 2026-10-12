// SPDX-License-Identifier: Apache-2.0

// Two unique indexes on `accounts`, which holds the login identities of a user (docs/decisions/0001-editions-
// setup-and-accounts.md, section 2.6):
//
// - `(provider_id, account_id)`: one identity at a provider belongs to one user. Linking a GitHub identity
//   (src/github-signin/link.ts) checks that nobody has it, and this index makes the check hold when two
//   requests link the same identity at the same moment.
// - `(user_id, provider_id)`: a user has at most one identity per way to sign in, so an account is never
//   reachable from two GitHub accounts.
//
// Both hold for every row the app has written so far (a GitHub sign in made one user per GitHub id, and the
// password credential has the user id as its account id).
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createIndex("accounts_provider_account")
      .unique()
      .on("accounts")
      .columns(["provider_id", "account_id"])
      .execute();
    await db.schema
      .createIndex("accounts_user_provider")
      .unique()
      .on("accounts")
      .columns(["user_id", "provider_id"])
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex("accounts_user_provider").execute();
    await db.schema.dropIndex("accounts_provider_account").execute();
  },
};
