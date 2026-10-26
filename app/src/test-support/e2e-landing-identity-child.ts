// SPDX-License-Identifier: LicenseRef-Proprietary

// A program the Playwright journeys run (node runs this file directly, TypeScript types are stripped) to read the landing
// identity the app under test stored on a user. The app shows it nowhere (src/landing-identity/README.md), so the journey
// of the sign-up reads it from the Postgres database of the app, which is a separate process.
//
//   read <database url> <email>   -> {distinctId, sessionId, capturedAt} | null
//
// Prints one JSON line.
import { openPostgresDatabase } from "../db/postgres.ts";

const [command, databaseUrl, email] = process.argv.slice(2);
if (command !== "read" || !databaseUrl || !email)
  throw new Error(
    "Usage: e2e-landing-identity-child.ts read <database url> <email>",
  );

const db = openPostgresDatabase({ url: databaseUrl, poolMax: 1 });
try {
  const row = await db
    .selectFrom("users")
    .select([
      "posthog_distinct_id",
      "posthog_session_id",
      "posthog_captured_at",
    ])
    .where("email", "=", email)
    .executeTakeFirst();
  console.log(
    JSON.stringify(
      row === undefined
        ? null
        : {
            distinctId: row.posthog_distinct_id,
            sessionId: row.posthog_session_id,
            capturedAt: row.posthog_captured_at,
          },
    ),
  );
} finally {
  await db.destroy();
}
