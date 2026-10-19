// SPDX-License-Identifier: Apache-2.0

// A program the balance journal tests run as a separate OS process (node runs this file directly, TypeScript types are
// stripped): another app instance reserving holds on the same SQLite file. Prints "ready", waits for a line
// "go <epoch ms>", spins until that moment (a start barrier, so several processes begin together), then makes its
// reserves one after the other on its own connection and prints one JSON line: how many were granted and refused.
//
//   reserve <db> <workspaceId> <holdMicroUsd> <jobPrefix> <count>   -> {"ok": n, "refused": n}
import { createInterface } from "node:readline";
import { openDatabase } from "../db/connection.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";

const [command, databasePath, workspaceId, hold, prefix, count] =
  process.argv.slice(2);
if (command !== "reserve" || !databasePath || !workspaceId)
  throw new Error(
    "Usage: billing-child.ts reserve <db> <workspaceId> <hold> <jobPrefix> <count>",
  );

console.log("ready");
const lines = createInterface({ input: process.stdin });
lines.once("line", async (line) => {
  const startAt = Number(line.split(" ")[1]);
  while (Date.now() < startAt);
  const db = openDatabase({
    driver: "sqlite",
    path: databasePath,
    busyTimeoutMs: 30_000,
  });
  try {
    const journal = createBillingJournalRepository(db, workspaceId);
    let ok = 0;
    let refused = 0;
    for (let index = 0; index < Number(count); index += 1) {
      const result = await journal.reserve(Number(hold), `${prefix}-${index}`);
      if (result.ok) ok += 1;
      else refused += 1;
    }
    console.log(JSON.stringify({ ok, refused }));
    process.exitCode = 0;
  } catch (error) {
    console.log(JSON.stringify({ error: String(error) }));
    process.exitCode = 1;
  } finally {
    await db.destroy();
    lines.close();
  }
});
