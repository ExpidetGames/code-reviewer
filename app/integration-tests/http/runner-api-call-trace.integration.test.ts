// SPDX-License-Identifier: Apache-2.0

// The per-call trace of a Dynamic Review (#541) from the runner to the Runs view, through the real runner API
// over a real SQLite file: it is stored with the result of the job and read back as the page shows it, a job
// without one reads as none, and one that is not the contract's is dropped, the usage and the verdict stay.
import { describe, expect, it } from "vitest";
import { createRunsRepository } from "../../src/db/repositories/runs-repository.ts";
import type { RunnerCallTrace } from "../../src/runner-api/contract.ts";
import { createRunsService } from "../../src/runs/runs-service.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const trace: RunnerCallTrace = {
  truncated: false,
  modelCalls: [
    {
      index: 0,
      tMs: 1200,
      promptTokens: 14600,
      cacheRead: 0,
      cacheWrite: 14600,
      completionTokens: 492,
      costUsd: 0.0342,
      finishReason: "tool_calls",
      final: false,
      tools: [{ name: "read", count: 1 }],
    },
  ],
  toolCalls: [{ index: 0, name: "read", resultBytes: 812, isRepeat: false }],
};

async function claimedJob(h: RunnerApiHarness) {
  const job = await h.enqueueNew();
  const body = await h.claimed({ runnerId: "runner-a" });
  return { id: job.id, leaseToken: body.job.leaseToken };
}

const viewOf = (h: RunnerApiHarness) =>
  createRunsService({
    runs: createRunsRepository(h.db, h.workspaceId),
    redact: (text) => text,
  });

describe("the call trace of a completed job", () => {
  // #541-T08
  it("is stored with the result and read back by the Runs view", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    const response = await h.complete(job.id, job.leaseToken, {
      usage: { ...goodResult().usage!, callTrace: trace },
    });

    expect(response.status).toBe(200);
    const stored = await h.db
      .selectFrom("jobs")
      .select("result")
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(String(stored.result)).toContain('"callTrace"');
    expect((await viewOf(h).get(job.id))?.run.callTrace).toStrictEqual(trace);
  });

  // #541-T08
  it("reads as none for a job whose runner sent no trace", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {});

    const snapshot = await viewOf(h).get(job.id);
    expect(snapshot?.run.callTrace).toBeNull();
    expect(snapshot?.run.usage).not.toBeNull();
  });

  // #541-T07, #541-T08: observability only, so a trace that is not the contract's costs the trace and
  // nothing else: the usage and the verdict are stored, and the log says that it was dropped.
  it("is dropped when it is not the contract's, with the usage and the verdict stored and a line in the log", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    const response = await h.complete(job.id, job.leaseToken, {
      usage: {
        ...goodResult().usage!,
        callTrace: {
          ...trace,
          toolCalls: [{ ...trace.toolCalls[0], path: "SECRET-PATH" }],
        },
      } as never,
    });

    expect(response.status).toBe(200);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "succeeded" });
    const snapshot = await viewOf(h).get(job.id);
    expect(snapshot?.run.callTrace).toBeNull();
    expect(snapshot?.run.usage).toMatchObject({
      aiCalls: goodResult().usage?.aiCalls,
    });
    const lines = h.logLines().filter((line) => line.includes("callTrace"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(job.id);
    expect(lines[0]).toContain("dropped");
    expect(h.logLines().join("\n")).not.toContain("SECRET-PATH");
  });
});
