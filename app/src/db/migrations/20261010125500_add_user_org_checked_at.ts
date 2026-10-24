// SPDX-License-Identifier: LicenseRef-Proprietary

// `users.org_checked_at`: when the user's membership in the allowed GitHub organization was last
// confirmed (ISO 8601 text in UTC), or NULL when it never was. The access rule trusts a confirmation
// for 24 hours (src/auth/access-policy.ts). Better Auth reads and writes it as the additional user
// field `orgCheckedAt` (src/auth/auth.ts); src/auth/schema-drift.integration.test.ts keeps both in sync.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("users")
      .addColumn("org_checked_at", "text")
      .execute();
  },

  async down(db) {
    await db.schema.alterTable("users").dropColumn("org_checked_at").execute();
  },
};
