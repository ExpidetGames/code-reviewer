// SPDX-License-Identifier: LicenseRef-Proprietary

// The completion of a turn of the Implementer through the runner API (#754, part of #745): the result block reaches the session
// (the last pushed commit, the summary, the saved OpenCode session, `idle`) and the job (status, code, result), also when the turn
// failed after it had pushed commits; an invalid block, a block on another kind of job and a report with a lost lease change
// nothing; and what is stored is cleaned like the result of any job. The claim of a turn is not built yet (#753): the test claims
// it from the queue, as a runner would after that.
import { describe, expect, it } from "vitest";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { sha } from "../test-support/jobs.ts";
import {
  goodResult,
  startRunnerApiHarness,
} from "../test-support/runner-api-harness.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import type { ImplementerResult } from "./contract.ts";

const IMPLEMENTER = ["implementer"] as const;
const HEAD = sha("b");
const GHS = ["ghs", "abcdefghijklmnopqrstuvwxyz0123"].join("_");

const block = (
  overrides: Partial<ImplementerResult> = {},
): ImplementerResult => ({
  baseCommit: sha("a"),
  headCommit: HEAD,
  pushed: true,
  commits: [{ sha: HEAD, subject: "Add a health endpoint" }],
  filesChanged: [{ path: "src/health.ts", status: "added" }],
  summary: "Added a health endpoint.",
  opencode: { sessionId: "ses_1", version: "1.19.0" },
  ...overrides,
});

async function start() {
  const h = await startRunnerApiHarness();
  await addUser(h.db, "user-1");
  const sessions = createImplementerRepository(h.db, h.workspaceId);
  let counter = 0;
  /** A turn that a runner holds: queued by the queue, claimed with the engine `implementer`. */
  async function running() {
    counter += 1;
    h.clock.advance(1);
    const enqueued = await h.queue.enqueueImplementerTurn({
      repositoryId: h.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: `implementer/b${String(counter)}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
    });
    const claimed = await h.queue.claimNext("runner-a", IMPLEMENTER);
    if (claimed === null || claimed.job.id !== enqueued.job.id)
      throw new Error("the turn was not claimed");
    const turn = await sessions.getTurnByJob(claimed.job.id);
    if (turn === undefined) throw new Error("the turn is missing");
    return {
      job: claimed.job,
      leaseToken: claimed.leaseToken,
      sessionId: turn.session.id,
    };
  }
  const sessionOf = async (id: string) => {
    const session = await sessions.getSession(id);
    if (session === undefined) throw new Error("the session is missing");
    return session;
  };
  return { h, sessions, running, sessionOf };
}

describe("the completion of a turn", () => {
  // #754-T01
  it("stores the result and gives the session its pushed head, summary and OpenCode session, and sets it idle", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "running",
      headCommit: null,
    });

    const answer = await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block(),
    });

    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      job: { id: turn.job.id, status: "succeeded" },
      alreadyCompleted: false,
    });
    const job = await h.queue.get(turn.job.id);
    expect(job).toMatchObject({ status: "succeeded", errorCode: null });
    expect(job?.result).toMatchObject({ implementer: block() });
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "idle",
      headCommit: HEAD,
      summary: "Added a health endpoint.",
      opencodeSessionId: "ses_1",
      opencodeVersion: "1.19.0",
    });
  });

  // #754-T02
  it("keeps the block of a turn that stopped at its cost limit after it pushed: a failed job with visible work", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();

    const answer = await h.complete(turn.job.id, turn.leaseToken, {
      ok: false,
      errorCode: "cost_limit_reached",
      errorMessage: "stopped at the cost limit",
      implementer: block(),
    });

    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ job: { status: "failed" } });
    const job = await h.queue.get(turn.job.id);
    expect(job).toMatchObject({
      status: "failed",
      errorCode: "cost_limit_reached",
    });
    expect(job?.result).toMatchObject({ implementer: block() });
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "idle",
      headCommit: HEAD,
      summary: "Added a health endpoint.",
    });
  });

  // #754-T02
  it("does not name a head the remote refused, and keeps the head an earlier turn pushed", async () => {
    const { h, running, sessions, sessionOf } = await start();
    const turn = await running();
    await sessions.recordTurnResult(turn.sessionId, {
      headCommit: sha("c"),
      opencode: null,
      summary: null,
    });

    await h.complete(turn.job.id, turn.leaseToken, {
      ok: false,
      errorCode: "push_rejected",
      errorMessage: "refused",
      implementer: block({ pushed: false, summary: "Could not push." }),
    });

    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "idle",
      headCommit: sha("c"),
      summary: "Could not push.",
    });
  });

  // #754-T02 and the review of #771: a turn that failed before it had a repository reports no block, and the session still
  // becomes idle, keeping what it had.
  it("sets the session idle for a failure without a block, and changes none of its fields", async () => {
    const { h, running, sessions, sessionOf } = await start();
    const turn = await running();
    await sessions.recordTurnResult(turn.sessionId, {
      headCommit: sha("c"),
      opencode: { sessionId: "ses_0", version: "1.18.0" },
      summary: "Earlier.",
    });
    await h.queue.heartbeat(turn.job.id, turn.leaseToken);

    const answer = await h.complete(turn.job.id, turn.leaseToken, {
      ok: false,
      errorCode: "clone_failed",
      errorMessage: "the repository could not be downloaded",
    });

    expect(answer.status).toBe(200);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "clone_failed",
    });
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "idle",
      headCommit: sha("c"),
      summary: "Earlier.",
      opencodeSessionId: "ses_0",
    });
  });
});

describe("a result the app refuses", () => {
  const refused = async (
    h: Awaited<ReturnType<typeof start>>["h"],
    jobId: string,
    leaseToken: string,
    result: Parameters<typeof h.complete>[2],
    field: string,
  ) => {
    const answer = await h.complete(jobId, leaseToken, result);
    expect(answer.status).toBe(400);
    const body = (await answer.json()) as {
      error: { code: string; fields?: { field: string }[] };
    };
    expect(body.error.code).toBe("RUNNER_REQUEST_INVALID");
    expect(body.error.fields?.map((entry) => entry.field)).toContain(field);
  };

  // #754-T03
  it.each([
    ["a sha that is not 40 hex digits", { headCommit: "abc" }, "headCommit"],
    [
      "more than 200 commits",
      { commits: Array.from({ length: 201 }, () => block().commits[0]!) },
      "commits",
    ],
    [
      "a summary over 8192 characters",
      { summary: "s".repeat(8193) },
      "summary",
    ],
    ["a field the block does not have", { branch: "x" }, "branch"],
  ])(
    "does not complete the job for %s, and the session stays running",
    async (_name, change, field) => {
      const { h, running, sessionOf } = await start();
      const turn = await running();

      await refused(
        h,
        turn.job.id,
        turn.leaseToken,
        { implementer: { ...block(), ...change } as ImplementerResult },
        `result.implementer.${field}`,
      );

      expect(await h.queue.get(turn.job.id)).toMatchObject({
        status: "running",
        result: null,
      });
      expect(await sessionOf(turn.sessionId)).toMatchObject({
        status: "running",
        headCommit: null,
      });
    },
  );

  // #754-T03
  it("refuses a successful turn without a block", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();

    await refused(h, turn.job.id, turn.leaseToken, {}, "result.implementer");

    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "running" });
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "running",
    });
  });

  // #754-T03
  it("refuses a block on a Diff job, which stays running", async () => {
    const { h } = await start();
    const diff = await h.enqueueNew();
    const claimed = await h.queue.claimNext("runner-a", ["pr-agent"]);
    expect(claimed?.job.id).toBe(diff.id);

    await refused(
      h,
      diff.id,
      claimed!.leaseToken,
      { implementer: block() },
      "result.implementer",
    );

    expect(await h.queue.get(diff.id)).toMatchObject({
      status: "running",
      result: null,
    });
  });
});

describe("the report of a turn whose lease is lost", () => {
  // #754-T06
  it("is 409 and changes neither the job nor the session", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();
    const before = await h.snapshotJobs();

    const answer = await h.complete(turn.job.id, "stale-lease-token-0000", {
      implementer: block(),
    });

    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({
      error: { code: "RUNNER_LEASE_LOST" },
    });
    expect(await h.snapshotJobs()).toEqual(before);
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "running",
      headCommit: null,
      summary: null,
    });
  });

  // #754-T06 and the review of #771: a turn whose lease ran out ends without any report and idles its session; a report that
  // comes in late for the job, which is settled, changes nothing in it.
  it("leaves a session idle and unchanged when the job ended without a report and the report comes late", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();
    h.clock.advance(60 * 60 * 1000);
    await h.queue.expireStaleJobs();
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
    });
    expect(await sessionOf(turn.sessionId)).toMatchObject({ status: "idle" });

    const answer = await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block(),
    });

    expect(answer.status).toBe(409);
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "idle",
      headCommit: null,
      summary: null,
    });
  });

  // #754-T06
  it("does not let a repeated report with another result change the session", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();
    await h.complete(turn.job.id, turn.leaseToken, { implementer: block() });

    const repeated = await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block(),
    });
    const other = await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block({ headCommit: sha("d"), summary: "Another." }),
    });

    expect(await repeated.json()).toMatchObject({ alreadyCompleted: true });
    expect(other.status).toBe(409);
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      headCommit: HEAD,
      summary: "Added a health endpoint.",
    });
  });
});

describe("what is stored of a turn", () => {
  // #754-T04
  it("has no token, key or capability in the summary, the subjects or the paths", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();
    const key = "llm-key-of-the-workspace-0123456789";
    await h.setLlmKey(key);

    await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block({
        summary: `Pushed with ${GHS} and the key ${key}.`,
        commits: [{ sha: HEAD, subject: `Use ${key}` }],
        filesChanged: [{ path: `src/${GHS}.ts`, status: "added" }],
      }),
    });

    const stored = JSON.stringify((await h.queue.get(turn.job.id))?.result);
    expect(stored).not.toContain(GHS);
    expect(stored).not.toContain(key);
    const session = await sessionOf(turn.sessionId);
    expect(session.summary).not.toContain(GHS);
    expect(session.summary).not.toContain(key);
    expect(session.summary).toContain("[redacted]");
  });

  // #754-T05
  it("settles the usage record with the reported cost and tokens", async () => {
    const { h, running } = await start();
    const turn = await running();

    await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block(),
      usage: { ...goodResult().usage!, costUsd: 0.1534 },
    });

    const record = await createUsageRecordsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).get(turn.job.id);
    expect(record).toMatchObject({
      reviewKind: "implementer",
      state: "settled",
      costMicroUsd: 153_400,
      promptTokens: 12_000,
      completionTokens: 900,
    });
  });

  // #754-T05
  it("hides the model of the operator's key in the summary, the subjects and the usage, and keeps the cost for the settlement", async () => {
    const { h, running } = await start();
    const turn = await running();
    const model = "vendor/secret-model";
    const usage = createUsageRecordsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    );
    await usage.setKeyMode(turn.job.id, "managed");
    await h.claimedKeys.rememberModel(turn.job.id, model);
    await h.claimedKeys.rememberNative(turn.job.id, true);

    await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block({
        summary: `Done with ${model}.`,
        commits: [{ sha: HEAD, subject: `Ask ${model}` }],
      }),
      usage: { ...goodResult().usage!, model, costUsd: 0.2 },
    });

    const job = await h.queue.get(turn.job.id);
    expect(JSON.stringify(job?.result)).not.toContain(model);
    expect(job?.result).toMatchObject({
      usage: { model: null, costUsd: 0.2 },
      implementer: { summary: "Done with [model]." },
    });
    expect(await usage.get(turn.job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: 200_000,
    });
  });

  // #754-T05
  it("does not accept a turn on the operator's key as a success when its cost is unknown, and still records its work", async () => {
    const { h, running, sessionOf } = await start();
    const turn = await running();
    await createUsageRecordsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).setKeyMode(turn.job.id, "managed");
    await h.claimedKeys.rememberModel(turn.job.id, "vendor/secret-model");
    await h.claimedKeys.rememberNative(turn.job.id, true);

    await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block(),
      usage: { ...goodResult().usage!, costUsd: null },
    });

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_accounting_failed",
    });
    expect(await sessionOf(turn.sessionId)).toMatchObject({
      status: "idle",
      headCommit: HEAD,
    });
  });
});
