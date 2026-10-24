// SPDX-License-Identifier: LicenseRef-Proprietary

// `job_claimed_keys`: the LLM key a runner was handed with the claim of a job, encrypted, so that any app
// instance can still mask it in the result of the job after the key was rotated (docs/decisions/0001-
// editions-setup-and-accounts.md, section 2.10; it replaces the in-memory list of the runner API). One row per
// job; a later claim of the same job replaces it. The value is encrypted like every secret (AES-256-GCM, a key
// derived from `APP_SECRET`, the table, the job id and the field bound into the ciphertext). A row goes with
// its job, and the cleanup removes the rows of jobs that finished long ago (src/maintenance/).
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("job_claimed_keys")
      .addColumn("job_id", "text", (column) =>
        column.primaryKey().references("jobs.id").onDelete("cascade"),
      )
      .addColumn("ciphertext", "text", (column) => column.notNull())
      .addColumn("nonce", "text", (column) => column.notNull())
      .addColumn("key_version", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("job_claimed_keys").execute();
  },
};
