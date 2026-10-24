// SPDX-License-Identifier: Apache-2.0

// #657: the text of the review comment a run posted on GitHub, kept so the run detail can show what was posted (the
// Findings). The runner posts the comment itself and reports only its link; the app reads the comment once, right after
// the run ends (src/check-runs/service.ts), and keeps the body here, on the row that already belongs to the job and its
// workspace. null: not read yet (or never, for a run that posted nothing). An empty string: the comment was looked for
// and could not be read (deleted, or not written by the app), so it is not asked for again.
//
// Forward-only and safe next to a previous release: the column is nullable, an older instance never writes or reads it.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("job_check_runs")
      .addColumn("review_comment", "text")
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("job_check_runs")
      .dropColumn("review_comment")
      .execute();
  },
};
