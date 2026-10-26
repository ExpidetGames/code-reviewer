// SPDX-License-Identifier: LicenseRef-Proprietary

// A program the start credit tests run as a separate OS process (node runs this file directly, TypeScript types are
// stripped): another app instance meeting billing for a workspace on the same database. Prints "ready", waits for a line
// "go <epoch ms>", spins until that moment (a start barrier, so several processes begin together), runs the one function of the
// start credit on its own connection and prints one JSON line: the status it got.
//
//   grant <db> <workspaceId>   -> {"status": "granted" | "already_granted" | "account_already_granted" | ...}
import { createInterface } from "node:readline";
import { openPostgresDatabase } from "../db/postgres.ts";
import { ensureStartCredit } from "../billing/start-credit.ts";

const [command, databaseUrl, workspaceId] = process.argv.slice(2);
if (command !== "grant" || !databaseUrl || !workspaceId)
  throw new Error("Usage: start-credit-child.ts grant <db> <workspaceId>");

// The grant logs a line on stdout; the parent reads only JSON lines from it.
console.info = console.error;
console.log("ready");
const lines = createInterface({ input: process.stdin });
lines.once("line", async (line) => {
  const startAt = Number(line.split(" ")[1]);
  while (Date.now() < startAt);
  const db = openPostgresDatabase({ url: databaseUrl, poolMax: 2 });
  try {
    const result = await ensureStartCredit(db, workspaceId);
    console.log(JSON.stringify({ status: result.status }));
    process.exitCode = 0;
  } catch (error) {
    console.log(JSON.stringify({ error: String(error) }));
    process.exitCode = 1;
  } finally {
    await db.destroy();
    lines.close();
  }
});
