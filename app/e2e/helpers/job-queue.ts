// Acts on the job queue of the app under test the way a runner does (claim, complete) and the way a
// delivery does (enqueue), through the app's real queue code on its database file. The journeys never
// write rows themselves. See src/test-support/e2e-queue-child.ts.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { e2eEnv } from "./e2e-env";

const run = promisify(execFile);
const CHILD = resolve(process.cwd(), "src/test-support/e2e-queue-child.ts");

async function queueCommand<T>(command: string, input: unknown): Promise<T> {
  const { stdout } = await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      CHILD,
      command,
      resolve(process.cwd(), e2eEnv.databasePath),
      JSON.stringify(input),
    ],
    { cwd: process.cwd() },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as T;
}

export type QueuedJob = { id: string };
export type Claim = { job: { id: string } | null; leaseToken?: string };

/** A job a person started, for a pull request of a repository the app knows. */
export async function enqueueManualRun(input: {
  repository: string;
  prNumber: number;
  command?: "review" | "improve" | "describe" | "ask";
  actorLogin: string;
}): Promise<QueuedJob> {
  const result = await queueCommand<{ status: string; job: QueuedJob }>(
    "enqueue",
    {
      repository: input.repository,
      prNumber: input.prNumber,
      prUrl: `https://github.com/${input.repository}/pull/${String(input.prNumber)}`,
      headSha: String(input.prNumber).padStart(40, "0"),
      command: input.command ?? "review",
      triggerKind: "manual",
      actorLogin: input.actorLogin,
    },
  );
  return result.job;
}

/** What a runner does first: takes the oldest due job. */
export async function claimNextRun(runnerId = "e2e-runner"): Promise<{
  id: string;
  leaseToken: string;
}> {
  const claim = await queueCommand<Claim>("claim", { runnerId });
  if (claim.job === null || claim.leaseToken === undefined)
    throw new Error("There was no job to claim.");
  return { id: claim.job.id, leaseToken: claim.leaseToken };
}

/**
 * What a runner does for one run it knows: takes jobs from the queue, oldest first, until it holds
 * the job with this id (jobs of other journeys that wait in front of it are taken on the way and left
 * running; those journeys do not run at the same time, see playwright.config.ts).
 */
export async function claimRun(
  jobId: string,
  runnerId = "e2e-runner",
): Promise<{ id: string; leaseToken: string }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const claim = await claimNextRun(runnerId);
    if (claim.id === jobId) return claim;
  }
  throw new Error(`The job ${jobId} was never handed out.`);
}

/** What a runner reports at the end. */
export async function completeRun(
  claim: { id: string; leaseToken: string },
  outcome:
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; errorCode: string; result?: Record<string, unknown> },
): Promise<void> {
  const result = await queueCommand<{ status: string }>("complete", {
    jobId: claim.id,
    leaseToken: claim.leaseToken,
    outcome,
  });
  if (result.status !== "completed")
    throw new Error(`The run was not completed: ${result.status}`);
}
