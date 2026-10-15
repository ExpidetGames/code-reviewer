// SPDX-License-Identifier: Apache-2.0

// Remembers which LLM keys were handed to the runner with the claim of a job. The key can be rotated while a job
// runs, and the runner's log may then hold the old key: to mask it in the result the app needs the key of the
// claim as well as the current one. A job can be handed a key more than once (a claim again after a lost lease, the
// fetches of a Worker, #276), and the operator's key can be rotated in between, so **every key handed out for the job
// is kept**, up to `CLAIMED_KEYS_PER_JOB` (the fetch budget of a claim); past that the oldest is forgotten. A key
// that is already remembered takes no new place.
//
// The key is kept in the DATABASE, encrypted like every secret (AES-256-GCM, a key derived from `APP_SECRET`,
// the table, the id of the job and the field bound into the ciphertext; the sealed text is the JSON list of the keys,
// and a row of the earlier format, one plain key, is still read), so any app instance can mask a result,
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

/** How many keys are remembered for one job: the fetches of one claim (`MAX_WORKER_FETCHES`). */
export const CLAIMED_KEYS_PER_JOB = 3;

export type ClaimedKeys = {
  /**
   * Remembers a key a runner got for `jobId`, next to those handed out for it before (the oldest is forgotten past
   * `CLAIMED_KEYS_PER_JOB`; a key already remembered is not added again).
   */
  remember(jobId: string, apiKey: string): Promise<void>;
  /** The keys handed out for the job, oldest first (empty if unknown or unreadable). */
  keysOf(jobId: string): Promise<string[]>;
};

/** The keys in a sealed text: the list of the current format, or the one plain key of the earlier one. */
function keysIn(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "keys" in parsed &&
      Array.isArray(parsed.keys) &&
      parsed.keys.every((key): key is string => typeof key === "string")
    )
      return parsed.keys;
  } catch {
    // Not JSON: a key of the earlier format.
  }
  return [text];
}

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
  const location = (jobId: string) => ({
    table: TABLE,
    rowId: jobId,
    field: FIELD,
  });
  async function read(
    rows: ReturnType<typeof createJobClaimedKeysRepository>,
    jobId: string,
  ): Promise<string[]> {
    const row = await rows.get(jobId);
    if (row === undefined) return [];
    try {
      return keysIn(
        decryptSecret(appSecret(), location(jobId), {
          keyVersion: row.keyVersion,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
        }),
      );
    } catch {
      return [];
    }
  }
  return {
    async remember(jobId, apiKey) {
      // Read and write in one transaction, so two fetches of a job do not drop each other's key.
      await db.transaction().execute(async (trx) => {
        const rows = createJobClaimedKeysRepository(trx, now);
        const known = await read(rows, jobId);
        const keys = known.includes(apiKey)
          ? known
          : [...known, apiKey].slice(-CLAIMED_KEYS_PER_JOB);
        const sealed = encryptSecret(
          appSecret(),
          location(jobId),
          JSON.stringify({ keys }),
        );
        await rows.put({
          jobId,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          keyVersion: sealed.keyVersion,
        });
      });
    },

    keysOf: (jobId) => read(createJobClaimedKeysRepository(db, now), jobId),
  };
}
