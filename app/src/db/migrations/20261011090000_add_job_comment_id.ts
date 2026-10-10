// A job started by a comment command remembers the comment it came from (`comment_id`, the
// platform's id of the comment, as text). A partial unique index allows at most one job per comment
// in a repository: GitHub's delivery id is not covered by the signature, so a captured signed
// comment replayed under a new delivery id would otherwise start the same command again after the
// first job has finished. The column is null for every job that does not come from a comment, and a
// unique index allows any number of those.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("jobs")
      .addColumn("comment_id", "text")
      .execute();

    await db.schema
      .createIndex("jobs_comment_unique")
      .on("jobs")
      .columns(["repository_id", "comment_id"])
      .unique()
      .where(sql<boolean>`comment_id is not null`)
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex("jobs_comment_unique").execute();
    await db.schema.alterTable("jobs").dropColumn("comment_id").execute();
  },
};
