// SPDX-License-Identifier: Apache-2.0

// The runs the instance admin looks at (#541): the list of the newest jobs of every workspace and one job
// with its usage and its call trace. A job is read by its id; the log of a run never leaves the server on this
// path, and the cost of a run is shown in full (the operator is the one who pays for it).
import { describe, expect, it } from "vitest";
import type {
  DirectoryRun,
  DirectoryRunRow,
  JobDirectoryRepository,
} from "../db/repositories/job-directory-repository.ts";
import type { Job } from "../jobs/job-types.ts";
import {
  createAdminRunsService,
  ADMIN_RUNS_LIST_LIMIT,
} from "./runs-service.ts";

const NOW = new Date("2026-10-10T12:10:00.000Z");
const ID = "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11";

const row: DirectoryRunRow = {
  id: ID,
  workspaceSlug: "acme",
  workspaceName: "Acme",
  project: "acme/widgets",
  prNumber: 7,
  reviewKind: "dynamic",
  status: "succeeded",
  createdAt: "2026-10-10T12:00:00.000Z",
  claimedAt: "2026-10-10T12:00:10.000Z",
  finishedAt: "2026-10-10T12:03:15.000Z",
  errorCode: null,
};

const trace = {
  truncated: false,
  modelCalls: [
    {
      index: 0,
      tMs: 10,
      promptTokens: 100,
      cacheRead: 0,
      cacheWrite: 100,
      completionTokens: 10,
      costUsd: 0.01,
      finishReason: "stop",
      final: true,
      tools: [],
    },
  ],
  toolCalls: [],
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: ID,
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    prNumber: 7,
    prUrl: "https://github.com/acme/widgets/pull/7",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    reviewKind: "dynamic",
    command: "review",
    args: "SECRET-QUESTION",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: null,
    status: "succeeded",
    runAfter: "2026-10-10T12:00:00.000Z",
    attempts: 0,
    runnerId: "runner-1",
    leaseToken: "SECRET-LEASE",
    leaseExpiresAt: null,
    heartbeatAt: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    claimedAt: "2026-10-10T12:00:10.000Z",
    finishedAt: "2026-10-10T12:03:15.000Z",
    errorCode: null,
    result: {
      ok: true,
      commentUrl: null,
      logTail: "SECRET-LOG",
      usage: {
        model: "vendor/model",
        totalTokens: 110,
        aiCalls: 1,
        costUsd: 0.01,
        stoppedEarly: "cost_limit",
        callTrace: trace,
      },
    },
    supersededBy: null,
    ...overrides,
  } as Job;
}

function directory(stored: DirectoryRun | undefined): JobDirectoryRepository {
  return {
    list: async (limit) => ({ runs: [row], hasMore: limit < 1000 && false }),
    get: async () => stored,
  };
}

describe("the admin's list of runs", () => {
  // #541-T09
  it("names the workspace, the project and the status of every run, without usage or log", async () => {
    const service = createAdminRunsService({
      directory: directory(undefined),
      now: () => NOW,
    });

    const list = await service.list();

    expect(list.runs).toEqual([
      {
        id: ID,
        workspaceSlug: "acme",
        workspaceName: "Acme",
        project: "acme/widgets",
        prNumber: 7,
        reviewKind: "dynamic",
        status: "succeeded",
        createdAt: "2026-10-10T12:00:00.000Z",
        durationMs: 185_000,
        errorCode: null,
      },
    ]);
    expect(list.hasMore).toBe(false);
    expect(ADMIN_RUNS_LIST_LIMIT).toBe(100);
  });
});

describe("one run for the admin", () => {
  const stored: DirectoryRun = {
    job: job(),
    project: "acme/widgets",
    workspaceSlug: "acme",
    workspaceName: "Acme",
  };

  // #541-T09
  it("has the usage, the cost, the stop reason and the call trace", async () => {
    const service = createAdminRunsService({
      directory: directory(stored),
      now: () => NOW,
    });

    const detail = await service.get(ID);

    expect(detail).toMatchObject({
      workspaceSlug: "acme",
      workspaceName: "Acme",
      run: {
        id: ID,
        project: "acme/widgets",
        usage: { aiCalls: 1, costUsd: 0.01, stoppedEarly: "cost_limit" },
        callTrace: trace,
        costHidden: false,
      },
    });
  });

  // #541-T09
  it("never carries the log, the question or the lease", async () => {
    const service = createAdminRunsService({
      directory: directory(stored),
      now: () => NOW,
    });

    const text = JSON.stringify(await service.get(ID));

    expect(text).not.toContain("SECRET-LOG");
    expect(text).not.toContain("SECRET-QUESTION");
    expect(text).not.toContain("SECRET-LEASE");
  });

  // #541-T09
  it("shows the cost of a run on the operator's key in full", async () => {
    const service = createAdminRunsService({
      directory: directory(stored),
      now: () => NOW,
    });

    const detail = await service.get(ID);

    expect(detail?.run.callTrace?.modelCalls[0]?.costUsd).toBe(0.01);
  });

  // #541-T09
  it("has no call trace for a run without one", async () => {
    const without = {
      ...stored,
      job: job({ result: { ok: true, logTail: "" } as never }),
    };
    const service = createAdminRunsService({
      directory: directory(without),
      now: () => NOW,
    });

    expect((await service.get(ID))?.run.callTrace).toBeNull();
  });

  // #541-T09
  it("asks the database only for an id that has the shape of one, and has nothing for an unknown run", async () => {
    let asked = 0;
    const service = createAdminRunsService({
      directory: {
        list: async () => ({ runs: [], hasMore: false }),
        get: async () => {
          asked += 1;
          return undefined;
        },
      },
      now: () => NOW,
    });

    expect(await service.get("not-an-id")).toBeUndefined();
    expect(await service.get("../etc/passwd")).toBeUndefined();
    expect(asked).toBe(0);
    expect(await service.get(ID)).toBeUndefined();
    expect(asked).toBe(1);
  });
});
