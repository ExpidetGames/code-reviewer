// SPDX-License-Identifier: LicenseRef-Proprietary

// #692: the PostHog identity of the landing page on the user. A visitor of code-review.com who accepted tracking brings
// the PostHog distinct id and session id to the sign-up (src/landing-identity/README.md); they are written here, once,
// and nothing reads them back. Forward only and additive: three nullable columns, no row touched, so the version that is
// still running keeps working on the same database. The same on both engines.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("users")
      .addColumn("posthog_distinct_id", "text")
      .execute();
    await db.schema
      .alterTable("users")
      .addColumn("posthog_session_id", "text")
      .execute();
    await db.schema
      .alterTable("users")
      .addColumn("posthog_captured_at", "text")
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("users")
      .dropColumn("posthog_captured_at")
      .execute();
    await db.schema
      .alterTable("users")
      .dropColumn("posthog_session_id")
      .execute();
    await db.schema
      .alterTable("users")
      .dropColumn("posthog_distinct_id")
      .execute();
  },
};
