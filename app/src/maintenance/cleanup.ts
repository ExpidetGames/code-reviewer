// SPDX-License-Identifier: Apache-2.0

// Removes rows nobody needs any more, so tables that an outsider can make grow stay small: the counters of
// `rate_limits` (one per address, link or account that was ever counted), the verification links and the
// reset links that expired or were used. Nothing that still has an effect is removed.
//
// - A counter is removed once its window is over, and every window of the app is at most 24 hours
//   (`LONGEST_RATE_LIMIT_WINDOW_MS`, pinned by the test against every window constant), so no counter in
//   force is ever removed and no limit starts early.
// - A signed state (the single-use side of the round trips through GitHub) is removed once it has expired.
// - A verification link is kept for a week after it expired or was used, so that someone who holds it
//   (and its password) is told "used" or "expired" and not just "not valid". After that it is gone.
// - The LLM key that was handed to a runner with the claim of a job (`job_claimed_keys`, encrypted) is kept
//   for a week after the job finished, as long as a late or repeated report of the job can still need it to
//   mask the key in its result. After that it is gone: a key that was rotated away does not stay in the
//   database for ever. (The row also goes with its job.)
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import { createJobClaimedKeysRepository } from "../db/repositories/job-claimed-keys-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { Database } from "../db/schema.ts";

export const LONGEST_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_TOKEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A reset link is kept as long, for the same reason: a hash that is still known answers "used" or "expired". */
export const PASSWORD_RESET_TOKEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the key of a finished job is kept: a late report of the job can still be masked. */
export const JOB_CLAIMED_KEY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export type CleanupResult = {
  rateLimits: number;
  verificationTokens: number;
  passwordResetTokens: number;
  jobClaimedKeys: number;
};

export async function cleanUpExpiredRows(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): Promise<CleanupResult> {
  const rateLimits = await createRateLimitsRepository(db, now).deleteExpired(
    LONGEST_RATE_LIMIT_WINDOW_MS,
  );
  const cutoff = formatTimestamp(
    new Date(now().getTime() - VERIFICATION_TOKEN_KEEP_MS),
  );
  const tokens = await db
    .deleteFrom("email_verification_tokens")
    .where((eb) =>
      eb.or([eb("expires_at", "<=", cutoff), eb("used_at", "<=", cutoff)]),
    )
    .executeTakeFirst();
  const resetCutoff = formatTimestamp(
    new Date(now().getTime() - PASSWORD_RESET_TOKEN_KEEP_MS),
  );
  const resets = await db
    .deleteFrom("password_reset_tokens")
    .where((eb) =>
      eb.or([
        eb("expires_at", "<=", resetCutoff),
        eb("used_at", "<=", resetCutoff),
      ]),
    )
    .executeTakeFirst();
  // A signed state lives ten minutes; one that has expired is of no use to anyone (not counted in the result).
  await db
    .deleteFrom("signed_states")
    .where("expires_at", "<=", formatTimestamp(now()))
    .execute();
  const jobClaimedKeys = await createJobClaimedKeysRepository(
    db,
    now,
  ).deleteFinishedBefore(new Date(now().getTime() - JOB_CLAIMED_KEY_KEEP_MS));
  return {
    rateLimits,
    verificationTokens: Number(tokens.numDeletedRows),
    passwordResetTokens: Number(resets.numDeletedRows),
    jobClaimedKeys,
  };
}
