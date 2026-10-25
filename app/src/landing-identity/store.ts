// SPDX-License-Identifier: LicenseRef-Proprietary

// Writes the landing identity on a user (#692). First touch: the columns are written once, while `posthog_captured_at` is
// still empty, in one statement that checks and writes together, so two sign-ins at the same moment cannot both win and
// a later visit never replaces what is there. Nothing reads the values back: they are for the owner's own analysis in the
// database, not for the app (src/landing-identity/README.md).
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import type { LandingIdentity } from "./identity.ts";

/** The columns of a new user row. */
export function landingIdentityColumns(
  identity: LandingIdentity | null,
  now: Date,
) {
  return identity === null
    ? {}
    : {
        posthog_distinct_id: identity.distinctId,
        posthog_session_id: identity.sessionId,
        posthog_captured_at: formatTimestamp(now),
      };
}

/** Stores the identity on an existing user whose own is still empty; true when it was written. */
export async function recordLandingIdentity(
  db: Kysely<Database>,
  userId: string,
  identity: LandingIdentity,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .updateTable("users")
    .set(landingIdentityColumns(identity, now))
    .where("id", "=", userId)
    .where("posthog_captured_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}
