// A program the job queue tests run as a separate OS process (node runs this file directly,
// TypeScript types are stripped): a second app instance or runner API handler working on the same
// database file. Every command prints "ready", waits for a line "go <epoch ms>", spins until that
// moment (a start barrier, so several processes begin together) and prints one JSON line with the
// answer of the queue. The queue's clock is fixed to the ISO time given, so lease arithmetic is
// exact and no test sleeps.
//
//   claim <db> <nowIso> <runnerId>      -> {"job": <Job> | null}
//   enqueue <db> <nowIso> <inputJson>   -> <EnqueueResult>
import { createInterface } from "node:readline";
import { openDatabase } from "../db/connection.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import type { EnqueueJobInput } from "../jobs/job-types.ts";

const [command, databasePath, nowIso, argument] = process.argv.slice(2);
if (!databasePath || !nowIso)
  throw new Error("Usage: jobs-child.ts <claim|enqueue> <db> <nowIso> <arg>");

console.log("ready");
createInterface({ input: process.stdin }).once("line", async (line) => {
  const startAt = Number(line.split(" ")[1]);
  while (Date.now() < startAt);
  const db = openDatabase({ path: databasePath, busyTimeoutMs: 5000 });
  try {
    const queue = createJobQueue(db, { now: () => new Date(nowIso) });
    if (command === "claim") {
      const claimed = await queue.claimNext(String(argument));
      console.log(JSON.stringify({ job: claimed?.job ?? null }));
    } else if (command === "enqueue") {
      const input = JSON.parse(String(argument)) as EnqueueJobInput;
      console.log(JSON.stringify(await queue.enqueue(input)));
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
    process.exit(0);
  } catch (error) {
    console.log(JSON.stringify({ error: String(error) }));
    process.exit(1);
  } finally {
    await db.destroy();
  }
});
