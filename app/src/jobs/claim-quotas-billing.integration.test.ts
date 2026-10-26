// SPDX-License-Identifier: LicenseRef-Proprietary

// The plan run quotas while billing is on (ADR 0006, D5; #499), : the
// run limits of an entitlements row (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`) are not enforced at the claim then, while the
// suspension, unreadable entitlements and the cost limits are. With billing off nothing changes: a self-hosting operator keeps
// the limits of epic #268 (src/usage/README.md).
import { describe, expect, it } from "vitest";
import { createLlmKeyModeStore } from "../llm/key-mode-store.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import type {
  EntitlementLimits,
  EntitlementsData,
} from "../workspaces/entitlements.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const ENGINES = ["pr-agent", "opencode"] as const;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

function entitlements(
  overrides: {
    limits?: Partial<EntitlementLimits>;
    suspended?: boolean;
  } = {},
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode: "own",
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

describe("the plan run quotas at claim, billing on and off,", () => {
  async function start(billing: "on" | "off") {
    const database = await open();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
    });
    if (billing === "on") {
      await setBillingSwitch(fixture.db, true);
      await fundWorkspace(
        fixture.db,
        fixture.workspaceId,
        1_000_000_000,
        fixture.clock.now,
      );
    }
    return fixture;
  }

  const entitle = (
    fixture: JobQueueFixture,
    overrides: Parameters<typeof entitlements>[0],
  ) =>
    createWorkspaceEntitlementsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).put(entitlements(overrides), null);

  let pr = 100;
  function enqueue(
    fixture: JobQueueFixture,
    reviewKind: "diff" | "dynamic" = "diff",
  ) {
    pr += 1;
    fixture.clock.advance(1);
    return fixture.enqueueNew({ prNumber: pr, reviewKind });
  }

  // #499-T08
  it("does not refuse a job of a kind whose run limit is 0 while billing is on", async () => {
    const fixture = await start("on");
    await entitle(fixture, {
      limits: { diffRunsPerPeriod: 0, dynamicRunsPerPeriod: 0 },
    });
    const diff = await enqueue(fixture, "diff");
    const dynamic = await enqueue(fixture, "dynamic");

    const first = await fixture.queue.claimNext("runner-a", ENGINES);
    const second = await fixture.queue.claimNext("runner-a", ENGINES);

    expect([first?.job.id, second?.job.id]).toEqual([diff.id, dynamic.id]);
  });

  // #499-T08
  it("does not count the runs of the period against a limit while billing is on", async () => {
    const fixture = await start("on");
    await entitle(fixture, { limits: { diffRunsPerPeriod: 1 } });
    const jobs = [await enqueue(fixture), await enqueue(fixture)];

    const claimed = [
      await fixture.queue.claimNext("runner-a", ENGINES),
      await fixture.queue.claimNext("runner-a", ENGINES),
    ];

    expect(claimed.map((answer) => answer?.job.id)).toEqual(
      jobs.map((job) => job.id),
    );
  });

  // #499-T08
  it("still refuses a suspended workspace while billing is on", async () => {
    const fixture = await start("on");
    await entitle(fixture, { suspended: true });
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
  });

  // #499-T08
  it("still fails a job whose entitlements cannot be read while billing is on", async () => {
    const fixture = await start("on");
    await entitle(fixture, { limits: { diffRunsPerPeriod: 5 } });
    await fixture.db
      .updateTable("workspace_entitlements")
      .set({ limits: "{not json" })
      .execute();
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect((await fixture.queue.get(job.id))?.errorCode).toBe(
      "entitlements_invalid",
    );
  });

  // #499-T09
  it("refuses a job at a run limit of 0 as before while billing is off", async () => {
    const fixture = await start("off");
    await entitle(fixture, { limits: { diffRunsPerPeriod: 0 } });
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });

  // #499-T09
  it("refuses at a run limit once the limit is used up while billing is off, and not once it is on", async () => {
    const fixture = await start("off");
    await entitle(fixture, { limits: { diffRunsPerPeriod: 1 } });
    const first = await enqueue(fixture);
    const second = await enqueue(fixture);
    expect((await fixture.queue.claimNext("runner-a", ENGINES))?.job.id).toBe(
      first.id,
    );
    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
    expect((await fixture.queue.get(second.id))?.errorCode).toBe(
      "quota_exhausted",
    );

    await setBillingSwitch(fixture.db, true);
    await fundWorkspace(
      fixture.db,
      fixture.workspaceId,
      1_000_000_000,
      fixture.clock.now,
    );
    const third = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a", ENGINES))?.job.id).toBe(
      third.id,
    );
  });

  // #499-T11
  it("still refuses at the own-key cost limit while billing is on", async () => {
    const fixture = await start("on");
    await entitle(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
    });
    // While billing is on the cost limit of the key the workspace CHOSE applies (#496), not the entitlement's key mode.
    await createLlmKeyModeStore(fixture.db, fixture.workspaceId).set(
      "own",
      null,
    );
    const spent = await enqueue(fixture);
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    expect(claimed?.job.id).toBe(spent.id);
    await fixture.queue.complete(spent.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {
        ok: true,
        usage: { promptTokens: 100, completionTokens: 10, costUsd: 1.2 },
      },
    });
    const next = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(next.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });
});
