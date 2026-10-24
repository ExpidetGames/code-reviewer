// SPDX-License-Identifier: LicenseRef-Proprietary

// `users.org_checked_for`: the GitHub organization that `org_checked_at` was confirmed for, so a
// confirmation is never reused when `ALLOWED_GITHUB_ORG` names another organization (the access rule
// in src/auth/access-policy.ts compares them). Better Auth reads and writes it as the additional
// user field `orgCheckedFor`. Existing confirmations have no organization and are asked again once.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("users")
      .addColumn("org_checked_for", "text")
      .execute();
  },

  async down(db) {
    await db.schema.alterTable("users").dropColumn("org_checked_for").execute();
  },
};
