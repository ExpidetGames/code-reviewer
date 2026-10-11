// A program the Playwright journeys run (node runs this file directly, TypeScript types are
// stripped; `--conditions=react-server` lets `server-only` pass) to act on the job queue of the app
// under test the way the running app and a runner do: through the real job queue on the app's SQLite
// file, never by writing rows. The app is a separate process with the same file open (WAL), so what
// happens here shows up in the pages through the app's own reads.
//
//   enqueue  <db> <json>   {repository: "owner/name", ...EnqueueJobInput without repositoryId}
//   claim    <db> <json>   {runnerId}                        -> {job, leaseToken} | {job: null}
//   complete <db> <json>   {jobId, leaseToken, outcome}      -> the CompleteResult
//
// Every command prints one JSON line. The id of a repository is looked up by its name.
import { openDatabase } from "../db/connection.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import type { EnqueueJobInput, JobOutcome } from "../jobs/job-types.ts";

const [command, databasePath, argument] = process.argv.slice(2);
if (!command || !databasePath || !argument)
  throw new Error("Usage: e2e-queue-child.ts <command> <db> <json>");

const db = openDatabase({ path: databasePath, busyTimeoutMs: 5000 });
try {
  const queue = createJobQueue(db);
  const input = JSON.parse(argument) as Record<string, unknown>;
  if (command === "enqueue") {
    const { repository, ...rest } = input as {
      repository: string;
    } & Omit<EnqueueJobInput, "repositoryId">;
    const found = (await createRepositoriesRepository(db).list()).find(
      (candidate) => candidate.fullName === repository,
    );
    if (found === undefined) throw new Error(`No repository ${repository}.`);
    console.log(
      JSON.stringify(await queue.enqueue({ ...rest, repositoryId: found.id })),
    );
  } else if (command === "claim") {
    const claimed = await queue.claimNext(String(input.runnerId));
    console.log(JSON.stringify(claimed ?? { job: null }));
  } else if (command === "complete") {
    const { jobId, leaseToken, outcome } = input as {
      jobId: string;
      leaseToken: string;
      outcome: JobOutcome;
    };
    console.log(
      JSON.stringify(await queue.complete(jobId, leaseToken, outcome)),
    );
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  await db.destroy();
}
