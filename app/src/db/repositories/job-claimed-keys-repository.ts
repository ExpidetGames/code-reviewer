// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the LLM keys that were handed to runners with the claim of a job (the table `job_claimed_keys`,
// src/runner-api/claimed-keys.ts). Instance level, like the lease side of the queue: runners serve the whole
// instance, and the one reader (completing a job) holds the job and knows the job's workspace. This module only
// moves sealed rows; the encryption is in the caller.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type JobClaimedKeyRow = {
  jobId: string;
  ciphertext: string;
  nonce: string;
  keyVersion: number;
};

export type JobClaimedKeysRepository = {
  get(jobId: string): Promise<JobClaimedKeyRow | undefined>;
  /** Inserts the key of the job or replaces it (a later claim of the same job). */
  put(row: JobClaimedKeyRow): Promise<void>;
  /** Removes the keys of the jobs that finished at or before `cutoff`. Returns how many. */
  deleteFinishedBefore(cutoff: Date): Promise<number>;
};

export function createJobClaimedKeysRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): JobClaimedKeysRepository {
  return {
    async get(jobId) {
      const row = await db
        .selectFrom("job_claimed_keys")
        .selectAll()
        .where("job_id", "=", jobId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            jobId: row.job_id,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            keyVersion: row.key_version,
          };
    },

    async put(row) {
      const created_at = formatTimestamp(now());
      await db
        .insertInto("job_claimed_keys")
        .values({
          job_id: row.jobId,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          key_version: row.keyVersion,
          created_at,
        })
        .onConflict((conflict) =>
          conflict.column("job_id").doUpdateSet({
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            key_version: row.keyVersion,
            created_at,
          }),
        )
        .execute();
    },

    async deleteFinishedBefore(cutoff) {
      // ISO 8601 UTC text sorts like time, so the comparison is done on the text.
      const result = await db
        .deleteFrom("job_claimed_keys")
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.finished_at", "<=", formatTimestamp(cutoff)),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
