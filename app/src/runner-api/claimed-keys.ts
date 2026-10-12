// SPDX-License-Identifier: Apache-2.0

// Remembers which LLM key was handed to the runner with the claim of a job. The key can be rotated while a job
// runs, and the runner's log may then hold the old key: to mask it in the result the app needs the key of the
// claim as well as the current one.
//
// The key is kept in the DATABASE, encrypted like every secret (AES-256-GCM, a key derived from `APP_SECRET`,
// the table, the id of the job and the field bound into the ciphertext), so any app instance can mask a result,
// not only the one that handed the key out (docs/decisions/0001-editions-setup-and-accounts.md, section 2.10).
// The row goes with its job, and the cleanup removes the rows of jobs that finished long ago
// (src/maintenance/cleanup.ts). A key is not forgotten when its job completes: a repeated completion is compared
// on the stored form and must be masked the same way.
//
// The value is never logged and never leaves this module except as the list `keysOf` returns to the code that
// masks a result. A row that cannot be read (another `APP_SECRET`, a changed row) is skipped: masking is best
// effort, and the shape of a credential is still masked (`redact.ts`).
import type { Kysely } from "kysely";
import { decryptSecret, encryptSecret } from "../crypto/secret-box.ts";
import { createJobClaimedKeysRepository } from "../db/repositories/job-claimed-keys-repository.ts";
import type { Database } from "../db/schema.ts";

const TABLE = "job_claimed_keys";
const FIELD = "api_key";

export type ClaimedKeys = {
  /** Remembers the key a runner got for `jobId` (a later claim of the same job replaces it). */
  remember(jobId: string, apiKey: string): Promise<void>;
  /** The key handed out with the last claim of the job, as a list (empty if unknown or unreadable). */
  keysOf(jobId: string): Promise<string[]>;
};

export function createClaimedKeys({
  db,
  appSecret,
  now = () => new Date(),
}: {
  db: Kysely<Database>;
  /** The master key (`APP_SECRET`), asked for when a key is stored or read. */
  appSecret: () => string;
  now?: () => Date;
}): ClaimedKeys {
  const rows = createJobClaimedKeysRepository(db, now);
  const location = (jobId: string) => ({
    table: TABLE,
    rowId: jobId,
    field: FIELD,
  });
  return {
    async remember(jobId, apiKey) {
      const sealed = encryptSecret(appSecret(), location(jobId), apiKey);
      await rows.put({
        jobId,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        keyVersion: sealed.keyVersion,
      });
    },

    async keysOf(jobId) {
      const row = await rows.get(jobId);
      if (row === undefined) return [];
      try {
        return [
          decryptSecret(appSecret(), location(jobId), {
            keyVersion: row.keyVersion,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
          }),
        ];
      } catch {
        return [];
      }
    },
  };
}
