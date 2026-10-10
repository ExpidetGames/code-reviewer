// The comments that were already answered with a job: one row per (repository, comment), pointing at
// the job that answers it. A comment that created a job and a comment that found an equal job
// already waiting or running (so no new one was needed) are both recorded. GitHub's delivery id is
// not covered by the signature, so a captured signed comment replayed under a new delivery id would
// otherwise start its command again after the job has finished; with the row, the replay finds the
// job instead. The primary key makes "one answer per comment" a promise of the database.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("job_comments")
      .addColumn("repository_id", "text", (column) =>
        column.notNull().references("repositories.id"),
      )
      // The platform's id of the comment, as text.
      .addColumn("comment_id", "text", (column) => column.notNull())
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("jobs.id"),
      )
      .addPrimaryKeyConstraint("job_comments_pk", [
        "repository_id",
        "comment_id",
      ])
      .execute();

    // Looking up the comments of a job (the UI, later).
    await db.schema
      .createIndex("job_comments_job")
      .on("job_comments")
      .column("job_id")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("job_comments").execute();
  },
};
