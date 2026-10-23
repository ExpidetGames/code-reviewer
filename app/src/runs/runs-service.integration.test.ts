// SPDX-License-Identifier: Apache-2.0

// Pins down the runs read side against a real SQLite file: the jobs are made through the job queue
// (enqueue, claim, complete) and read back as the pages see them.
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { sha } from "../test-support/jobs.ts";
import { sessionUser } from "../test-support/session-lookup.ts";
import { createRunsFixture } from "../test-support/runs.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createRunsRepository } from "../db/repositories/runs-repository.ts";
import { createJobCheckRunsRepository } from "../db/repositories/job-check-runs-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createRunsRouteHandlers } from "./http.ts";
import {
  createLastRunSource,
  createRunsService,
  parseRunsFilter,
} from "./runs-service.ts";

describe("the runs list", () => {
  // CR-35-T01
  it("lists the runs of both projects, the newest first, with project, pull request, command, status and times", async () => {
    const f = await createRunsFixture();
    const first = await f.finished({
      ok: true,
      result: { ok: true, commentUrl: null, logTail: "" },
    });
    f.clock.advance(1000);
    // A historical run of a removed command (#203): seeded directly, since the queue cannot create
    // one any more. It must stay readable with its original command and status.
    const second = await f.seedHistoricalJob({
      command: "improve",
      repositoryId: f.otherRepositoryId,
      status: "failed",
      errorCode: "timeout",
    });
    const third = await f.running({ triggerKind: "manual" });
    const fourth = await f.waiting({ repositoryId: f.otherRepositoryId });

    const { runs } = await f.runs.list({});

    expect(runs.map((run) => run.id)).toEqual([
      fourth.id,
      third.id,
      second.id,
      first.id,
    ]);
    expect(runs.map((run) => [run.project, run.status, run.command])).toEqual([
      ["acme/widgets", "queued", "review"],
      ["acme/gadgets", "running", "review"],
      ["acme/widgets", "failed", "improve"],
      ["acme/gadgets", "succeeded", "review"],
    ]);
    const [waiting, going, failed] = runs;
    expect(waiting).toMatchObject({ startedAt: null, durationMs: null });
    expect(going?.startedAt).not.toBeNull();
    expect(failed).toMatchObject({
      prNumber: second.prNumber,
      problem: expect.stringContaining("time limit") as unknown,
    });
  });

  // CR-35-T02
  it("shows only the runs that match the project and the status together", async () => {
    const f = await createRunsFixture();
    const failedHere = await f.finished({ ok: false, errorCode: "timeout" });
    await f.finished({ ok: true, result: { ok: true } });
    await f.finished(
      { ok: false, errorCode: "timeout" },
      { repositoryId: f.otherRepositoryId },
    );

    const byProject = await f.runs.list({ repositoryId: f.repositoryId });
    const both = await f.runs.list({
      repositoryId: f.repositoryId,
      status: "failed",
    });
    const byStatus = await f.runs.list({ status: "failed" });

    expect(byProject.runs).toHaveLength(2);
    expect(both.runs.map((run) => run.id)).toEqual([failedHere.id]);
    expect(byStatus.runs).toHaveLength(2);
  });

  // CR-35-T03
  it("returns an empty list when there is no run and when the filter matches none", async () => {
    const f = await createRunsFixture();
    expect((await f.runs.list({})).runs).toEqual([]);

    await f.finished({ ok: true, result: { ok: true } });

    expect((await f.runs.list({ status: "running" })).runs).toEqual([]);
  });

  it("cuts the list at the limit and says so", async () => {
    const f = await createRunsFixture();
    await f.finished({ ok: true, result: { ok: true } });
    await f.finished({ ok: true, result: { ok: true } });

    const all = await f.runsRepository.list({ limit: 5 });
    const cut = await f.runsRepository.list({ limit: 1 });

    expect(all).toMatchObject({ hasMore: false });
    expect(all.runs).toHaveLength(2);
    expect(cut.hasMore).toBe(true);
    expect(cut.runs).toHaveLength(1);
  });

  it("counts a running run to the time of the answer", async () => {
    const f = await createRunsFixture();
    await f.running();
    f.clock.advance(30_000);

    const { runs, generatedAt } = await f.runs.list({});

    expect(generatedAt).toBe(f.clock.now().toISOString());
    expect(runs[0]?.durationMs).toBe(30_000);
  });
});

describe("one run", () => {
  // CR-35-T04
  it("holds the pull request, command, trigger, times, comment link and error code of a finished run, and not its log", async () => {
    const f = await createRunsFixture();
    const job = await f.finished(
      {
        ok: false,
        errorCode: "llm_timeout",
        result: {
          ok: false,
          commentUrl: null,
          errorCode: "llm_timeout",
          logTail: "waited 60 s\nno answer",
          logTruncated: true,
        },
      },
      { triggerKind: "comment", actorLogin: "alice" },
    );

    const snapshot = await f.runs.get(job.id);

    expect(snapshot?.run).toMatchObject({
      id: job.id,
      project: "acme/gadgets",
      prNumber: job.prNumber,
      command: "review",
      trigger: "Comment by alice",
      status: "failed",
      errorCode: "llm_timeout",
      errorCodeKnown: true,
      problem: "The AI provider took too long to answer.",
      durationMs: 50_000,
    });
    expect(snapshot?.run).not.toHaveProperty("log");
    expect(JSON.stringify(snapshot)).not.toContain("no answer");
  });

  // CR-35-T04
  it("links the comment of a succeeded run", async () => {
    const f = await createRunsFixture();
    const job = await f.finished({
      ok: true,
      result: {
        ok: true,
        commentUrl: "https://github.com/acme/widgets/pull/1#issuecomment-5",
        logTail: "done",
      },
    });

    const snapshot = await f.runs.get(job.id);

    expect(snapshot?.run.commentUrl).toBe(
      "https://github.com/acme/widgets/pull/1#issuecomment-5",
    );
  });

  // CR-35-T05
  it("finds nothing for an id nobody has or that is not an id", async () => {
    const f = await createRunsFixture();
    await f.finished({ ok: true, result: { ok: true } });

    for (const id of [
      "00000000-0000-4000-8000-000000000000",
      "7",
      "../../etc/passwd",
      "' OR 1=1 --",
      "",
      "x".repeat(5000),
    ]) {
      expect(await f.runs.get(id)).toBeUndefined();
    }
  });

  // #657-T04
  it("shows the review comment the run posted, redacted with the function it is given, and carries no log and no call trace", async () => {
    const f = await createRunsFixture();
    const job = await f.finished({
      ok: true,
      result: {
        ok: true,
        logTail: "the log of the runner",
        usage: { aiCalls: 1 },
      },
    });
    const checks = createJobCheckRunsRepository(f.db, f.workspaceId);
    await checks.take(job.id, { leaseMs: 60_000, maxAttempts: 5 });
    await checks.recordReviewComment(
      job.id,
      "## Review\n\nused sk-or-v1-abcdefabcdefabcdef here",
    );
    const { createRunsService } = await import("./runs-service.ts");
    const redacting = createRunsService({
      runs: f.runsRepository,
      now: f.clock.now,
      redact: (text) => text.replace(/sk-or-[\w-]+/, "[redacted]"),
    });

    const snapshot = await redacting.get(job.id);

    expect(snapshot?.run.reviewText).toBe("## Review\n\nused [redacted] here");
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("the log of the runner");
    expect(snapshot?.run).not.toHaveProperty("log");
    expect(snapshot?.run).not.toHaveProperty("callTrace");
  });

  // #657-T04
  it("has no review text for a run whose comment was never kept or could not be read", async () => {
    const f = await createRunsFixture();
    const never = await f.finished({ ok: true, result: { ok: true } });
    const unreadable = await f.finished({ ok: true, result: { ok: true } });
    const checks = createJobCheckRunsRepository(f.db, f.workspaceId);
    await checks.take(unreadable.id, { leaseMs: 60_000, maxAttempts: 5 });
    await checks.recordReviewComment(unreadable.id, "");

    expect((await f.runs.get(never.id))?.run.reviewText).toBeNull();
    expect((await f.runs.get(unreadable.id))?.run.reviewText).toBeNull();
  });
});

describe("what leaves the server", () => {
  // CR-35-T15
  it("carries no lease token, runner name, delivery id or lease time in the list or the detail", async () => {
    const f = await createRunsFixture();
    const finished = await f.finished({
      ok: true,
      result: {
        ok: true,
        commentUrl: "https://github.com/acme/widgets/pull/1#c",
        logTail: "ok",
        usage: { model: "some/model", costUsd: 0.5 },
      },
    });
    const running = await f.running();
    const token = await f.tokenOf(running.id);
    const finishedToken = await f.tokenOf(finished.id);

    const listText = JSON.stringify(await f.runs.list({}));
    const detailText = JSON.stringify(await f.runs.get(running.id));
    const finishedText = JSON.stringify(await f.runs.get(finished.id));

    for (const text of [listText, detailText, finishedText]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(finishedToken);
      expect(text).not.toContain("runner-1");
      expect(text).not.toMatch(/lease|heartbeat|deliveryId|runnerId/i);
      expect(text).not.toContain("some/model");
    }
  });
});

describe("the usage of a run", () => {
  // #201-T31
  it("is in the detail of a finished run with the model, summed tokens, calls and cost, and never in the list", async () => {
    const f = await createRunsFixture({ dynamicReview: true });
    const finished = await f.finished(
      {
        ok: true,
        result: {
          ok: true,
          commentUrl: "https://github.com/acme/widgets/pull/1#c",
          logTail: "ok",
          usage: {
            model: "vendor/dynamic-model",
            promptTokens: 12_000,
            completionTokens: 900,
            totalTokens: 12_900,
            aiCalls: 7,
            fallbackUsed: false,
            costUsd: null,
          },
        },
      },
      { reviewKind: "dynamic" },
    );

    const detail = await f.runs.get(finished.id);
    const list = await f.runs.list({});

    expect(detail?.run).toMatchObject({
      reviewKind: "dynamic",
      usage: {
        model: "vendor/dynamic-model",
        totalTokens: 12_900,
        aiCalls: 7,
        costUsd: null,
      },
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /promptTokens|completionTokens|fallbackUsed/,
    );
    expect(JSON.stringify(list)).not.toContain("vendor/dynamic-model");

    // A member of another workspace reads neither the run nor its usage.
    const otherRuns = createRunsService({
      runs: createRunsRepository(f.db, await addWorkspace(f.db, "bravo")),
      now: f.clock.now,
    });
    expect(await otherRuns.get(finished.id)).toBeUndefined();
    expect(JSON.stringify(await otherRuns.list({}))).not.toContain(
      "vendor/dynamic-model",
    );
  });

  // #267-T07
  it("stores and shows a small exact cost as the runner reported it", async () => {
    const f = await createRunsFixture({ dynamicReview: true });
    const finished = await f.finished(
      {
        ok: true,
        result: {
          ok: true,
          commentUrl: "https://github.com/acme/widgets/pull/1#c",
          logTail: "ok",
          usage: {
            model: "vendor/dynamic-model",
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            aiCalls: 2,
            fallbackUsed: false,
            costUsd: 5.79e-5,
          },
        },
      },
      { reviewKind: "dynamic" },
    );

    const detail = await f.runs.get(finished.id);

    expect(detail?.run.usage?.costUsd).toBe(5.79e-5);
  });
});

describe("the usage of a run on a managed quality level (#283)", () => {
  const usage = {
    model: "vendor/tier-model",
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    aiCalls: 2,
    fallbackUsed: false,
    costUsd: 0.0123,
  };

  async function finishedRun(tier: "high" | null) {
    const f = await createRunsFixture();
    const finished = await f.finished({
      ok: true,
      result: {
        ok: true,
        commentUrl: "https://github.com/acme/widgets/pull/1#c",
        logTail: "ok",
        usage,
      },
    });
    if (tier !== null) {
      const records = createUsageRecordsRepository(
        f.db,
        f.workspaceId,
        f.clock.now,
      );
      await records.reserve(finished.id, "managed");
      // The record may be settled already (setModelTier only changes a reserved one): write the column.
      await f.db
        .updateTable("usage_records")
        .set({ model_tier: tier })
        .where("job_id", "=", finished.id)
        .execute();
    }
    return { f, finished };
  }

  // #283-T07
  // #434-T11
  it("shows the tokens and calls and no cost, in the data as well as on the page", async () => {
    const { f, finished } = await finishedRun("high");

    const detail = await f.runs.get(finished.id);

    expect(detail?.run).toMatchObject({
      costHidden: true,
      usage: { totalTokens: 120, aiCalls: 2, costUsd: null },
    });
    expect(JSON.stringify(detail)).not.toContain("0.0123");
  });

  // #432-T08
  it("hides the cost of a run on a catalog entry, which has no tier", async () => {
    const f = await createRunsFixture();
    const finished = await f.finished({
      ok: true,
      result: {
        ok: true,
        commentUrl: "https://github.com/acme/widgets/pull/1#c",
        logTail: "ok",
        usage,
      },
    });
    const records = createUsageRecordsRepository(
      f.db,
      f.workspaceId,
      f.clock.now,
    );
    await records.reserve(finished.id, "managed");
    // The record may be settled already (setSelection only changes a reserved one): write the columns.
    await f.db
      .updateTable("usage_records")
      .set({
        key_mode: "managed",
        catalog_entry_id: "mce_a",
        catalog_entry_name: "Thorough",
      })
      .where("job_id", "=", finished.id)
      .execute();

    const detail = await f.runs.get(finished.id);

    expect(detail?.run).toMatchObject({
      costHidden: true,
      usage: { totalTokens: 120, aiCalls: 2, costUsd: null },
    });
    expect(JSON.stringify(detail)).not.toContain("0.0123");
  });

  // #657-T02: the JSON route `GET /api/w/:workspace/runs/:id` answers the view of a member: no call trace, so none of its numbers.
  it("sends no call trace, and no cost or cache count of a call, in the JSON of the run route", async () => {
    const f = await createRunsFixture({ dynamicReview: true });
    const call = {
      index: 0,
      tMs: 1200,
      promptTokens: 14_600,
      cacheRead: 123_457,
      cacheWrite: 765_431,
      completionTokens: 492,
      costUsd: 0.0342,
      finishReason: "tool_calls",
      final: false,
      tools: [{ name: "read", count: 1 }],
    };
    const finished = await f.finished(
      {
        ok: true,
        result: {
          ok: true,
          commentUrl: "https://github.com/acme/widgets/pull/1#c",
          logTail: "ok",
          usage: {
            ...usage,
            callTrace: {
              truncated: false,
              modelCalls: [call],
              toolCalls: [],
            },
          },
        },
      },
      { reviewKind: "dynamic" },
    );
    const records = createUsageRecordsRepository(
      f.db,
      f.workspaceId,
      f.clock.now,
    );
    await records.reserve(finished.id, "managed");
    // The record may be settled already (setModelTier only changes a reserved one): write the column.
    await f.db
      .updateTable("usage_records")
      .set({ model_tier: "high" })
      .where("job_id", "=", finished.id)
      .execute();
    const route = createRunsRouteHandlers({
      requireUser: () => Promise.resolve(sessionUser("member")),
      service: f.runs,
    });

    const response = await route.detail(
      new Request(`https://app.test/api/w/default/runs/${finished.id}`),
      finished.id,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body).run).not.toHaveProperty("callTrace");
    expect(body).not.toContain("modelCalls");
    expect(body).not.toMatch(/123457|765431|0\.0342|0\.0123/);
  });

  // #283-T07
  it("keeps the cost of a run on the workspace's own key", async () => {
    const { f, finished } = await finishedRun(null);

    const detail = await f.runs.get(finished.id);

    expect(detail?.run).toMatchObject({
      costHidden: false,
      usage: { costUsd: 0.0123 },
    });
  });
});

describe("the filter of a request", () => {
  it("accepts a known status and a repository id, and treats empty values as no filter", () => {
    expect(parseRunsFilter({})).toEqual({ ok: true, filter: {} });
    expect(parseRunsFilter({ repositoryId: "", status: "" })).toEqual({
      ok: true,
      filter: {},
    });
    expect(
      parseRunsFilter({ repositoryId: "repo-1", status: "failed" }),
    ).toEqual({
      ok: true,
      filter: { repositoryId: "repo-1", status: "failed" },
    });
  });

  it("refuses an unknown status and an unusable repository id", () => {
    expect(parseRunsFilter({ status: "exploded" })).toEqual({ ok: false });
    expect(parseRunsFilter({ status: "FAILED" })).toEqual({ ok: false });
    expect(parseRunsFilter({ repositoryId: "x".repeat(200) })).toEqual({
      ok: false,
    });
    expect(parseRunsFilter({ repositoryId: "   " })).toEqual({ ok: false });
    expect(parseRunsFilter({ status: "  " })).toEqual({ ok: false });
  });

  it("trims white space around a value instead of silently matching nothing", () => {
    expect(
      parseRunsFilter({ repositoryId: " repo-1 ", status: " failed " }),
    ).toEqual({
      ok: true,
      filter: { repositoryId: "repo-1", status: "failed" },
    });
  });
});

describe("the last run of each repository", () => {
  // CR-34-T01
  it("is the newest job of each repository with the time it last changed", async () => {
    const f = await createRunsFixture();
    await f.finished({ ok: true, result: { ok: true } });
    const newest = await f.finished({ ok: false, errorCode: "timeout" });
    const elsewhere = await f.running({ repositoryId: f.otherRepositoryId });
    const source = createLastRunSource({ runs: f.runsRepository });

    const lastRuns = await source([
      f.repositoryId,
      f.otherRepositoryId,
      "none",
    ]);

    expect(lastRuns.get(f.repositoryId)).toEqual({
      status: "failed",
      at: newest.finishedAt,
    });
    expect(lastRuns.get(f.otherRepositoryId)).toEqual({
      status: "running",
      at: elsewhere.claimedAt,
    });
    expect(lastRuns.has("none")).toBe(false);
  });

  it("answers an empty map for no repositories and for repositories without runs", async () => {
    const f = await createRunsFixture();
    const source = createLastRunSource({ runs: f.runsRepository });

    expect((await source([])).size).toBe(0);
    expect((await source([f.repositoryId])).size).toBe(0);
  });

  it("shows a waiting run with the time it was queued", async () => {
    const f = await createRunsFixture();
    const job = await f.waiting();
    const source = createLastRunSource({ runs: f.runsRepository });

    expect((await source([f.repositoryId])).get(f.repositoryId)).toEqual({
      status: "queued",
      at: job.createdAt,
    });
  });
});

describe("the read side with many jobs", () => {
  async function withManyJobs(count: number) {
    const f = await createRunsFixture();
    for (let n = 1; n <= count; n += 1) {
      f.clock.advance(1000);
      await f.queue.enqueue({
        repositoryId: n % 5 === 0 ? f.otherRepositoryId : f.repositoryId,
        prNumber: n,
        prUrl: `https://github.com/acme/widgets/pull/${n}`,
        headSha: sha("a"),
        command: "review",
        triggerKind: "manual",
        actorLogin: "octocat",
      });
    }
    return f;
  }

  it("finds the newest job of each repository with one index lookup each, however many jobs there are", async () => {
    const f = await withManyJobs(5000);
    const source = createLastRunSource({ runs: f.runsRepository });
    const ids = [f.repositoryId, f.otherRepositoryId];

    const started = performance.now();
    const lastRuns = await source(ids);
    const took = performance.now() - started;

    expect(lastRuns.get(f.repositoryId)).toMatchObject({ status: "queued" });
    expect(lastRuns.size).toBe(2);
    // The scan of every job of a repository per job row took many seconds here; a lookup takes
    // milliseconds. The bound is generous so a loaded machine does not make this flaky.
    expect(took).toBeLessThan(1000);

    const plan = await sql<{ detail: string }>`
      explain query plan
      select id from jobs where repository_id = ${f.repositoryId}
      order by created_at desc, id desc limit 1`.execute(f.db);
    expect(plan.rows.map((row) => row.detail).join("\n")).toContain(
      "USING COVERING INDEX jobs_repository_recent",
    );
    expect(plan.rows.map((row) => row.detail).join("\n")).not.toContain(
      "TEMP B-TREE",
    );
  }, 120_000);

  it("reads the newest runs of one repository without sorting them all", async () => {
    const f = await withManyJobs(1500);

    const started = performance.now();
    const { runs, hasMore } = await f.runsRepository.list({
      repositoryId: f.repositoryId,
      limit: 100,
    });
    const took = performance.now() - started;

    expect(runs).toHaveLength(100);
    expect(hasMore).toBe(true);
    expect(took).toBeLessThan(1000);
  }, 120_000);

  it("reads the list without the stored result, the arguments or anything of the lease", async () => {
    const f = await createRunsFixture();
    await f.finished({
      ok: true,
      result: { ok: true, logTail: "a long log", commentUrl: null },
    });

    const { runs } = await f.runsRepository.list({ limit: 10 });

    expect(Object.keys(runs[0]?.job ?? {}).sort()).toEqual([
      "actorLogin",
      "claimedAt",
      "command",
      "createdAt",
      "errorCode",
      "finishedAt",
      "id",
      "prNumber",
      "prUrl",
      "repositoryId",
      "reviewKind",
      "status",
      "triggerKind",
    ]);
  });
});

// #203-T12
describe("a historical run of a removed command", () => {
  it("keeps its original command, its read-only question and its result", async () => {
    const f = await createRunsFixture();
    const run = await f.seedHistoricalJob({
      command: "ask",
      status: "succeeded",
      args: "why is ![x](https://evil.test/a.png) this?",
      result: {
        ok: true,
        commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
        logTail: "the answer",
      },
    });

    const listed = (await f.runs.list({})).runs.find(
      (entry) => entry.id === run.id,
    );
    expect(listed).toMatchObject({ command: "ask" });

    const detail = await f.runs.get(run.id);
    expect(detail?.run).toMatchObject({
      command: "ask",
      args: "why is ![x](https://evil.test/a.png) this?",
      commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
    });
  });
});
