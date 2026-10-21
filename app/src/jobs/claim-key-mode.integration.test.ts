// SPDX-License-Identifier: Apache-2.0

// The key mode at the claim (#496): the admission and the check of the balance work with the key mode that applies. While billing is
// off that is the entitlement's, whatever the workspace chose (nothing changes for a self-hoster); while billing is on it is the
// workspace's choice, our models by default. The rest of the entitlements (suspension, cost limits) is enforced either way. On SQLite
// (the claim is the same code on both databases; `claim-billing.integration.test.ts` runs the balance on Postgres too).
import { describe, expect, it } from "vitest";
import { createLlmKeyModeStore } from "../llm/key-mode-store.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createUsageSeeder } from "../test-support/usage-seed.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import type {
  EntitlementLimits,
  EntitlementsData,
  KeyMode,
} from "../workspaces/entitlements.ts";

const ENGINES = ["pr-agent", "opencode"] as const;
/** A Diff minute rate of zero: a review on the workspace's own key can cost nothing, one on our key still costs the AI. */
const FREE_MINUTES = {
  factorA: 50_000,
  minuteRateMicroUsd: { diff: 0, dynamic: 16_000 },
  diffAiReserveMicroUsd: 150_000,
} as const;

function entitlements(
  keyMode: KeyMode,
  overrides: { limits?: Partial<EntitlementLimits>; suspended?: boolean } = {},
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: overrides.suspended ?? false,
    suspensionCode: overrides.suspended === true ? "overdue" : null,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
      ...overrides.limits,
    },
  };
}

async function start(billing: "on" | "off") {
  const fixture = await createJobQueueFixture({ dynamicReview: true });
  await setBillingSwitch(
    fixture.db,
    billing === "on",
    billing === "on" ? FREE_MINUTES : null,
  );
  return fixture;
}

const choose = (fixture: JobQueueFixture, mode: KeyMode) =>
  createLlmKeyModeStore(fixture.db, fixture.workspaceId, fixture.clock.now).set(
    mode,
    null,
  );

const entitle = (fixture: JobQueueFixture, data: EntitlementsData) =>
  createWorkspaceEntitlementsRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  ).put(data, null);

let pr = 300;
function enqueue(fixture: JobQueueFixture) {
  pr += 1;
  fixture.clock.advance(1);
  return fixture.enqueueNew({ prNumber: pr, reviewKind: "diff" });
}

/** A settled run of the period that cost `costMicroUsd` on the given key, written straight into the tables. */
async function spend(
  fixture: JobQueueFixture,
  keyMode: KeyMode,
  costMicroUsd: number,
) {
  await createUsageSeeder(fixture.db).seed({
    workspaceId: fixture.workspaceId,
    state: "settled",
    keyMode,
    costMicroUsd,
    reservedAt: fixture.clock.now().toISOString(),
  });
}

describe("the claim, billing off", () => {
  // #496-T03
  it("claims a job of a workspace without entitlements, whatever it chose", async () => {
    const fixture = await start("off");
    await choose(fixture, "managed");
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(job.id);
  });

  // #496-T03
  it("keeps the cost limit of the entitlement's key mode, whatever the workspace chose", async () => {
    const fixture = await start("off");
    await entitle(
      fixture,
      entitlements("own", { limits: { ownKeyCostLimitMicroUsd: 1_000_000 } }),
    );
    await choose(fixture, "managed");
    await spend(fixture, "own", 1_200_000);
    const next = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(next.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });
});

describe("the claim, billing on", () => {
  // #496-T04
  it("lets a job of a workspace on its own key run on a balance of zero when its minutes are free", async () => {
    const fixture = await start("on");
    await choose(fixture, "own");
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(job.id);
  });

  // #496-T06
  it("refuses the same job on a balance of zero when the workspace chose our models", async () => {
    const fixture = await start("on");
    await choose(fixture, "managed");
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
    });
  });

  // #496-T02
  it("treats a workspace that has not chosen as on our models, whatever its entitlement says", async () => {
    const fixture = await start("on");
    await entitle(fixture, entitlements("own"));
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      errorCode: "insufficient_balance",
    });
  });

  // #496-T08
  it("still refuses a suspended workspace, whatever it chose", async () => {
    const fixture = await start("on");
    await entitle(fixture, entitlements("managed", { suspended: true }));
    await choose(fixture, "own");
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
  });

  // #496-T08
  it("applies the cost limit of the key the workspace chose, not the one of the entitlement", async () => {
    const fixture = await start("on");
    await entitle(
      fixture,
      entitlements("managed", {
        limits: {
          managedCostLimitMicroUsd: 1_000_000,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
    );
    await choose(fixture, "own");
    await spend(fixture, "managed", 1_200_000);
    const next = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    // The managed limit watches the runs on our key; the workspace is on its own key now, which has no limit.
    expect(claimed?.job.id).toBe(next.id);
  });
});
