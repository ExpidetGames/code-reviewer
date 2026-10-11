// The pages that show runs ask for the newest job of a repository (the last run on the project list)
// and for the newest jobs of one repository (the filtered list). Both read `(repository_id,
// created_at, id)` in order, so this index answers each as one lookup instead of a scan of every job
// of the repository.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createIndex("jobs_repository_recent")
      .on("jobs")
      .columns(["repository_id", "created_at", "id"])
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex("jobs_repository_recent").execute();
  },
};
