// SPDX-License-Identifier: Apache-2.0

// Pins down the queue when several callers work on one database file at the same moment. The other
// callers are real OS processes (a second app instance, a second runner API handler), started
// together by a barrier: better-sqlite3 blocks its thread on a lock, so threads in one process could
// not overlap, and a mock could not show what the write lock really does.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startDbProcess, type DbProcess } from "../test-support/db-process.ts";
import { createJobQueueFixture, sha, T0 } from "../test-support/jobs.ts";
import type { EnqueueJobInput, EnqueueResult, Job } from "./job-types.ts";

const childScript = fileURLToPath(
  new URL("../test-support/jobs-child.ts", import.meta.url),
);

/** Starts one child per argument list, releases them together and collects their JSON answers. */
async function runTogether<T>(argumentLists: string[][]): Promise<T[]> {
  const children: DbProcess[] = argumentLists.map((args) =>
    startDbProcess(args, childScript),
  );
  for (const child of children) expect(await child.nextLine()).toBe("ready");
  const startAt = Date.now() + 400;
  for (const child of children) child.send(`go ${startAt}`);
  const answers = await Promise.all(
    children.map(async (child) => JSON.parse(await child.nextLine()) as T),
  );
  for (const child of children) expect(await child.exited).toBe(0);
  return answers;
}

const claimArgs = (path: string, now: Date, runner: string) => [
  "claim",
  path,
  now.toISOString(),
  runner,
];
const enqueueArgs = (path: string, now: Date, input: EnqueueJobInput) => [
  "enqueue",
  path,
  now.toISOString(),
  JSON.stringify(input),
];

describe("claiming from two processes", () => {
  // CR-27-T04
  it("gives a single waiting job to exactly one of two runners claiming at the same moment", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});

    const answers = await runTogether<{
      job: Job | null;
      leaseToken: string | null;
    }>([
      claimArgs(fixture.databasePath, T0, "runner-a"),
      claimArgs(fixture.databasePath, T0, "runner-b"),
    ]);

    const winners = answers.filter((answer) => answer.job !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.job?.id).toBe(job.id);
    const stored = await fixture.queue.get(job.id);
    expect(stored?.status).toBe("running");
    expect(stored?.runnerId).toBe(winners[0]?.job?.runnerId);
  });

  it("gives two jobs of different pull requests to two runners, one each", async () => {
    const fixture = await createJobQueueFixture();
    const one = await fixture.enqueueNew({ prNumber: 1 });
    const two = await fixture.enqueueNew({ prNumber: 2 });

    const answers = await runTogether<{
      job: Job | null;
      leaseToken: string | null;
    }>([
      claimArgs(fixture.databasePath, T0, "runner-a"),
      claimArgs(fixture.databasePath, T0, "runner-b"),
    ]);

    expect(answers.map((answer) => answer.job?.id).sort()).toEqual(
      [one.id, two.id].sort(),
    );
  });

  it("never runs two jobs of one pull request, even when two runners claim at the same moment", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.enqueueNew({
      headSha: sha("a"),
      triggerKind: "comment",
      args: "first",
    });
    await fixture.enqueueNew({
      headSha: sha("b"),
      triggerKind: "comment",
      args: "second",
    });

    const answers = await runTogether<{
      job: Job | null;
      leaseToken: string | null;
    }>([
      claimArgs(fixture.databasePath, T0, "runner-a"),
      claimArgs(fixture.databasePath, T0, "runner-b"),
    ]);

    expect(answers.filter((answer) => answer.job !== null)).toHaveLength(1);
    expect(await fixture.queue.list({ status: "running" })).toHaveLength(1);
  });

  // CR-27-T10
  it("hands a job with an expired lease to exactly one of two runners and counts one lost attempt", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const first = await fixture.queue.claimNext("runner-a");
    const later = new Date(T0.getTime() + 3 * 60 * 1000);

    const answers = await runTogether<{
      job: Job | null;
      leaseToken: string | null;
    }>([
      claimArgs(fixture.databasePath, later, "runner-b"),
      claimArgs(fixture.databasePath, later, "runner-c"),
    ]);

    const winners = answers.filter((answer) => answer.job !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.job).toMatchObject({ id: job.id, attempts: 1 });
    expect(winners[0]?.leaseToken).toEqual(expect.any(String));
    expect(winners[0]?.leaseToken).not.toBe(first?.leaseToken);
    expect(await fixture.queue.get(job.id)).toMatchObject({
      attempts: 1,
      runnerId: winners[0]?.job?.runnerId,
    });
    expect(
      await fixture.queue.heartbeat(job.id, first?.leaseToken ?? ""),
    ).toEqual({
      status: "not_holder",
    });
  });
});

describe("enqueueing from two processes", () => {
  // CR-27-T08
  it("creates one job when the same automatic job is enqueued by two processes at the same moment", async () => {
    const fixture = await createJobQueueFixture();
    const input: EnqueueJobInput = {
      repositoryId: fixture.repositoryId,
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      headSha: sha("a"),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
    };

    const answers = await runTogether<EnqueueResult>([
      enqueueArgs(fixture.databasePath, T0, { ...input, deliveryId: "d-1" }),
      enqueueArgs(fixture.databasePath, T0, { ...input, deliveryId: "d-2" }),
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([
      "created",
      "existing",
    ]);
    expect(answers[0]?.job.id).toBe(answers[1]?.job.id);
    expect(await fixture.queue.list()).toHaveLength(1);
  });

  it("creates one job when the same delivery reaches two processes at the same moment", async () => {
    const fixture = await createJobQueueFixture();
    const input: EnqueueJobInput = {
      repositoryId: fixture.repositoryId,
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      headSha: sha("a"),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
      deliveryId: "delivery-1",
    };

    const answers = await runTogether<EnqueueResult>([
      enqueueArgs(fixture.databasePath, T0, input),
      enqueueArgs(fixture.databasePath, T0, input),
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([
      "created",
      "existing",
    ]);
    expect(await fixture.queue.list()).toHaveLength(1);
  });

  it("replaces the same waiting job only once when two newer commits arrive at the same moment", async () => {
    const fixture = await createJobQueueFixture();
    const old = await fixture.enqueueNew({ headSha: sha("a") });
    const base: EnqueueJobInput = {
      repositoryId: fixture.repositoryId,
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      headSha: sha("b"),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
    };

    const answers = await runTogether<EnqueueResult>([
      enqueueArgs(fixture.databasePath, T0, base),
      enqueueArgs(fixture.databasePath, T0, { ...base, headSha: sha("c") }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([
      "created",
      "created",
    ]);
    // The second one to run replaced the first one's job, so exactly one of the two still waits.
    const jobs = await fixture.queue.list({ status: "queued" });
    expect(jobs).toHaveLength(1);
    expect((await fixture.queue.get(old.id))?.status).toBe("superseded");
    expect(await fixture.queue.list({ status: "superseded" })).toHaveLength(2);
  });
});

// #203-T10
describe("removed commands in the queue", () => {
  it("are never claimed ahead of a review, even when two runners claim at the same moment", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.seedHistoricalJob({
      command: "ask",
      status: "queued",
      prNumber: 8,
      args: "why?",
    });
    await fixture.seedHistoricalJob({
      command: "improve",
      status: "queued",
      prNumber: 9,
    });
    const review = await fixture.enqueueNew({ prNumber: 7 });

    const answers = await runTogether<{ job: Job | null }>([
      claimArgs(fixture.databasePath, T0, "runner-a"),
      claimArgs(fixture.databasePath, T0, "runner-b"),
    ]);

    const winners = answers.filter((answer) => answer.job !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.job?.id).toBe(review.id);
    expect(winners[0]?.job?.command).toBe("review");
    const cancelled = await fixture.queue.list({ status: "cancelled" });
    expect(cancelled).toHaveLength(2);
    expect(cancelled.every((job) => job.errorCode === "command_removed")).toBe(
      true,
    );
  });
});
