// Pins down the runs read side against a real SQLite file: the jobs are made through the job queue
// (enqueue, claim, complete) and read back as the pages see them.
import { describe, expect, it } from "vitest";
import { createRunsFixture } from "../test-support/runs.ts";
import { createLastRunSource, parseRunsFilter } from "./runs-service.ts";

describe("the runs list", () => {
  // CR-35-T01
  it("lists the runs of both projects, the newest first, with project, pull request, command, status and times", async () => {
    const f = await createRunsFixture();
    const first = await f.finished({
      ok: true,
      result: { ok: true, commentUrl: null, logTail: "" },
    });
    const second = await f.finished(
      { ok: false, errorCode: "timeout" },
      { repositoryId: f.otherRepositoryId, command: "improve" },
    );
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
  it("holds the pull request, command, trigger, times, comment link, error code and log of a finished run", async () => {
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
      log: { text: "waited 60 s\nno answer", truncated: true },
    });
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

  it("redacts the log with the function it is given", async () => {
    const f = await createRunsFixture();
    const job = await f.finished({
      ok: true,
      result: { ok: true, logTail: "used sk-or-v1-abcdefabcdefabcdef here" },
    });
    const { createRunsService } = await import("./runs-service.ts");
    const redacting = createRunsService({
      runs: f.runsRepository,
      now: f.clock.now,
      redact: (text) => text.replace(/sk-or-[\w-]+/, "[redacted]"),
    });

    expect((await redacting.get(job.id))?.run.log.text).toBe(
      "used [redacted] here",
    );
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

describe("the filter of a request", () => {
  it("accepts a known status and a repository id, and treats empty values as no filter", () => {
    expect(parseRunsFilter({})).toEqual({ ok: true });
    expect(parseRunsFilter({ repositoryId: "", status: "" })).toEqual({
      ok: true,
    });
    expect(
      parseRunsFilter({ repositoryId: "repo-1", status: "failed" }),
    ).toEqual({ ok: true, repositoryId: "repo-1", status: "failed" });
  });

  it("refuses an unknown status and an unusable repository id", () => {
    expect(parseRunsFilter({ status: "exploded" })).toEqual({ ok: false });
    expect(parseRunsFilter({ status: "FAILED" })).toEqual({ ok: false });
    expect(parseRunsFilter({ repositoryId: "x".repeat(200) })).toEqual({
      ok: false,
    });
    expect(parseRunsFilter({ repositoryId: "   " })).toEqual({ ok: false });
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
