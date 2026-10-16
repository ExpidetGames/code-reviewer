// SPDX-License-Identifier: Apache-2.0

// The limits and the suspension of a workspace on every way a job is claimed (#277): the claim of a runner, the
// split claim of a Dispatcher and the claim by job id. A refused job ends `failed` with its code, is not handed to
// anybody (204), creates no credential and no usage record. The rules themselves (counts, cost, period, races)
// are pinned at the queue (src/jobs/claim-limits.integration.test.ts); here only that each door goes through them.
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

function entitlements(overrides: Partial<EntitlementsData> = {}) {
  return {
    planLabel: "plan",
    keyMode: "own",
    limits: {
      diffRunsPerPeriod: 0,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  } satisfies EntitlementsData;
}

async function limit(h: RunnerApiHarness, data: EntitlementsData) {
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(data, null);
}

/** Nothing of a refused job exists: no record, no stored key, no token minted for a repository. */
async function expectNothingConsumed(h: RunnerApiHarness) {
  expect(await h.db.selectFrom("usage_records").selectAll().execute()).toEqual(
    [],
  );
  expect(
    await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
  ).toEqual([]);
  expect(h.issuedJobTokens()).toEqual([]);
}

describe("a workspace that used up a limit, on every claim path", () => {
  // #277-T02
  // #277-T07
  it("answers a runner with 204, fails the job and hands out nothing", async () => {
    const h = await startRunnerApiHarness();
    await limit(h, entitlements());
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    await expectNothingConsumed(h);
  });

  // #277-T02
  // #277-T07
  it("answers a Dispatcher's split claim with 204 and mints no credential", async () => {
    const h = await startRunnerApiHarness();
    await limit(h, entitlements());
    const job = await h.enqueueNew();

    const response = await h.claimSplit();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    await expectNothingConsumed(h);
  });

  // #277-T02
  // #277-T07
  it("answers a claim by job id with 204 and fails exactly that job", async () => {
    const h = await startRunnerApiHarness();
    await limit(h, entitlements());
    const job = await h.enqueueNew();

    const response = await h.claimSplit({ jobId: job.id });

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    await expectNothingConsumed(h);
  });

  // #277-T05
  it("fails every job of a suspended workspace with its own code, on the legacy claim too", async () => {
    const h = await startRunnerApiHarness();
    await limit(
      h,
      entitlements({
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        suspended: true,
        suspensionCode: "overdue",
      }),
    );
    const job = await h.enqueueNew();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
    await expectNothingConsumed(h);
  });

  // #277-T05
  it("runs the next job as soon as the suspension is cleared", async () => {
    const h = await startRunnerApiHarness();
    await limit(
      h,
      entitlements({
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        suspended: true,
        suspensionCode: "overdue",
      }),
    );
    await h.enqueueNew();
    expect((await h.claim()).status).toBe(204);
    await limit(
      h,
      entitlements({
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
    );
    h.clock.advance(1000);
    const next = await h.enqueueNew({ prNumber: 8 });

    const body = await h.claimed();

    expect(body.job.id).toBe(next.id);
  });

  // #277-T01
  it("hands out the job as before when the limit is not reached", async () => {
    const h = await startRunnerApiHarness();
    await limit(
      h,
      entitlements({
        limits: {
          diffRunsPerPeriod: 1,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
    );
    const job = await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.id).toBe(job.id);
    expect(body.job.input.llm.apiKey).toEqual(expect.any(String));
  });

  // #271 follow-up: unreadable entitlements fail closed
  it("fails the job with entitlements_invalid, and does not throw, when the entitlements cannot be read", async () => {
    const h = await startRunnerApiHarness();
    await limit(h, entitlements({ suspended: false }));
    await h.db
      .updateTable("workspace_entitlements")
      .set({ limits: "{not json" })
      .execute();
    const job = await h.enqueueNew();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "entitlements_invalid",
    });
    await expectNothingConsumed(h);
  });

  // #277-P3
  it("fails a job of a suspended workspace as workspace_suspended, before the project guard looks at it", async () => {
    const check = vi.fn(async () => ({
      allow: false as const,
      errorCode: "project_deactivated" as const,
      outcome: "cancel" as const,
    }));
    const h = await startRunnerApiHarness({ guard: { check } });
    await limit(
      h,
      entitlements({
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        suspended: true,
        suspensionCode: "overdue",
      }),
    );
    const job = await h.enqueueNew();

    expect((await h.claim()).status).toBe(204);

    // The documented order: the entitlements are decided in the claim, the guard only sees jobs that run.
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
    expect(check).not.toHaveBeenCalled();
  });
});
