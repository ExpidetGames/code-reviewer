// SPDX-License-Identifier: Apache-2.0

// Removes rows nobody needs any more, so tables that an outsider can make grow stay small: the counters of
// `rate_limits` (one per address, link or account that was ever counted) and the verification links that
// expired or were used. Nothing that still has an effect is removed.
//
// - A counter is removed once its window is over, and every window of the app is at most 24 hours
//   (`LONGEST_RATE_LIMIT_WINDOW_MS`, pinned by the test against every window constant), so no counter in
//   force is ever removed and no limit starts early.
// - A verification link is kept for a week after it expired or was used, so that someone who holds it
//   (and its password) is told "used" or "expired" and not just "not valid". After that it is gone.
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { Database } from "../db/schema.ts";

export const LONGEST_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_TOKEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export type CleanupResult = { rateLimits: number; verificationTokens: number };

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
  return { rateLimits, verificationTokens: Number(tokens.numDeletedRows) };
}
