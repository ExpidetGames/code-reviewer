// SPDX-License-Identifier: LicenseRef-Proprietary

// A program the Playwright billing journeys run (node runs this file directly, TypeScript types are stripped;
// `--conditions=react-server` lets `server-only` pass) to read what the journal of the app under test says about itself:
// the journal's own `verify()` on the app's SQLite file, which compares the cached balance with the sum of the immutable entries.
// It only reads. The app is a separate process with the same file open (WAL).
//
//   verify <db>   -> {workspaceId, verification: JournalVerification, entries: {<type>: <count>}}
//
// For the default workspace. Prints one JSON line.
import { openDatabase } from "../db/connection.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";

const [command, databasePath] = process.argv.slice(2);
if (command !== "verify" || !databasePath)
  throw new Error("Usage: e2e-billing-journal-child.ts verify <db>");

const db = openDatabase({
  driver: "sqlite",
  path: databasePath,
  busyTimeoutMs: 5000,
});
try {
  const workspace = await db
    .selectFrom("workspaces")
    .select("id")
    .where("slug", "=", "default")
    .executeTakeFirstOrThrow();
  const journal = createBillingJournalRepository(db, workspace.id);
  const verification = await journal.verify();
  const rows = await db
    .selectFrom("billing_journal_entries")
    .select(["type"])
    .where("workspace_id", "=", workspace.id)
    .execute();
  const entries: Record<string, number> = {};
  for (const row of rows) entries[row.type] = (entries[row.type] ?? 0) + 1;
  console.log(
    JSON.stringify({ workspaceId: workspace.id, verification, entries }),
  );
} finally {
  await db.destroy();
}
