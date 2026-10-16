// SPDX-License-Identifier: Apache-2.0

// The plan view of a workspace read from real entitlements and real usage records on SQLite (#282): which runs
// count towards a limit, from when, and what the answer is allowed to hold. The page and the route on top are in
// ui/plan-page.test.tsx and integration-tests/http/plan-route*.integration.test.ts.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  createUsageSeeder,
  type SeededUsage,
} from "../test-support/usage-seed.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import type {
  EntitlementLimits,
  EntitlementsData,
} from "../workspaces/entitlements.ts";
import { planPageAvailable, readPlanView } from "./usage-summary.ts";

const PERIOD_START = "2026-10-01T00:00:00.000Z";
const IN_PERIOD = "2026-10-05T10:00:00.000Z";
const BEFORE_PERIOD = "2026-09-30T23:59:59.999Z";

function entitlements(
  overrides: Partial<Omit<EntitlementsData, "limits">> & {
    limits?: Partial<EntitlementLimits>;
  } = {},
): EntitlementsData {
  const { limits, ...rest } = overrides;
  return {
    planLabel: "Team",
    keyMode: "own",
    periodStart: PERIOD_START,
    suspended: false,
    suspensionCode: null,
    ...rest,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
      ...limits,
    },
  };
}

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const seeder = createUsageSeeder(db);
  return {
    db,
    workspaceId,
    entitle: (data: EntitlementsData, id = workspaceId) =>
      createWorkspaceEntitlementsRepository(db, id).put(data, null),
    use: (options: Omit<SeededUsage, "workspaceId">, id = workspaceId) =>
      seeder.seed({ reservedAt: IN_PERIOD, ...options, workspaceId: id }),
    view: () => readPlanView(db, workspaceId),
    other: () => addWorkspace(db, "other"),
  };
}

describe("the plan view of a workspace", () => {
  // #282-T01
  it("is unlimited, and has no page to link, for a workspace without entitlements", async () => {
    const t = await setup();
    await t.use({ state: "settled" });

    expect(await t.view()).toEqual({ kind: "unlimited" });
    expect(await planPageAvailable(t.db, t.workspaceId)).toBe(false);
  });

  it("has a page to link as soon as the workspace has entitlements of its own or the instance has a default", async () => {
    const t = await setup();
    const defaults = createInstanceSettingsRepository(t.db);

    await defaults.set("default_entitlements", entitlements(), null);
    expect(await planPageAvailable(t.db, t.workspaceId)).toBe(true);
    expect(await t.view()).toMatchObject({ kind: "limited" });

    await defaults.remove("default_entitlements");
    await t.entitle(entitlements());
    expect(await planPageAvailable(t.db, t.workspaceId)).toBe(true);
  });

  // #282-T02
  it("counts the runs of each kind against its limit", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        limits: { diffRunsPerPeriod: 5, dynamicRunsPerPeriod: 2 },
      }),
    );
    for (let i = 0; i < 3; i += 1)
      await t.use({ state: "settled", reviewKind: "diff", costMicroUsd: 10 });
    await t.use({ state: "reserved", reviewKind: "dynamic" });

    expect(await t.view()).toMatchObject({
      runs: {
        diff: { used: 3, limit: 5 },
        dynamic: { used: 1, limit: 2 },
      },
    });
  });

  // #282-T03
  it("keeps a limit of null as no limit", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        limits: { diffRunsPerPeriod: null, dynamicRunsPerPeriod: 2 },
      }),
    );
    await t.use({ state: "settled", reviewKind: "diff" });

    expect(await t.view()).toMatchObject({
      runs: { diff: { used: 1, limit: null } },
    });
  });

  // #282-T05
  it("does not count a run that started before the period", async () => {
    const t = await setup();
    await t.entitle(entitlements({ limits: { diffRunsPerPeriod: 5 } }));
    await t.use({ reservedAt: BEFORE_PERIOD, state: "settled" });
    await t.use({ reservedAt: PERIOD_START, state: "settled" });

    expect(await t.view()).toMatchObject({
      runs: { diff: { used: 1 } },
    });
  });

  // #282-T10
  it("counts a reserved run and leaves out a void one", async () => {
    const t = await setup();
    await t.entitle(entitlements({ limits: { diffRunsPerPeriod: 5 } }));
    await t.use({ state: "reserved" });
    await t.use({ state: "settled" });
    await t.use({ state: "void" });

    expect(await t.view()).toMatchObject({
      runs: { diff: { used: 2 } },
    });
  });

  it("counts the runs of this workspace only", async () => {
    const t = await setup();
    await t.entitle(entitlements({ limits: { diffRunsPerPeriod: 5 } }));
    const other = await t.other();
    await t.use({ state: "settled" }, other);

    expect(await t.view()).toMatchObject({ runs: { diff: { used: 0 } } });
  });

  // #282-T06
  it("says that reviews are paused for a suspended workspace, without a reason", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({ suspended: true, suspensionCode: "overdue" }),
    );

    const view = await t.view();

    expect(view).toMatchObject({ kind: "limited", suspended: true });
    expect(JSON.stringify(view)).not.toContain("overdue");
  });

  // #282-T04
  it("reports the share of the cost limit that the settled runs on the operator's key used", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        keyMode: "managed",
        limits: { managedCostLimitMicroUsd: 10_000_000 },
      }),
    );
    await t.use({
      state: "settled",
      keyMode: "managed",
      costMicroUsd: 4_000_000,
    });
    await t.use({
      state: "settled",
      keyMode: "managed",
      costMicroUsd: 2_200_000,
    });
    // Not counted: another key, an earlier period, a run that is still going.
    await t.use({ state: "settled", keyMode: "own", costMicroUsd: 9_000_000 });
    await t.use({
      state: "settled",
      keyMode: "managed",
      costMicroUsd: 9_000_000,
      reservedAt: BEFORE_PERIOD,
    });
    await t.use({ state: "reserved", keyMode: "managed" });

    const view = await t.view();

    expect(view).toMatchObject({ cost: { percentUsed: 62 } });
    expect(JSON.stringify(view)).not.toMatch(/6200000|10000000|9000000/);
  });

  // #361 (plan page)
  it("reports the share of the own-key cost limit that the settled runs on the workspace's own key used", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        keyMode: "own",
        limits: { ownKeyCostLimitMicroUsd: 10_000_000 },
      }),
    );
    await t.use({ state: "settled", keyMode: "own", costMicroUsd: 4_000_000 });
    await t.use({ state: "settled", keyMode: "own", costMicroUsd: 2_200_000 });
    // Not counted: the operator's key, an earlier period, a run that is still going, a run that never counted.
    await t.use({
      state: "settled",
      keyMode: "managed",
      costMicroUsd: 9_000_000,
    });
    await t.use({
      state: "settled",
      keyMode: "own",
      costMicroUsd: 9_000_000,
      reservedAt: BEFORE_PERIOD,
    });
    await t.use({ state: "reserved", keyMode: "own" });
    await t.use({ state: "void", keyMode: "own" });

    const view = await t.view();

    expect(view).toMatchObject({ managed: false, cost: { percentUsed: 62 } });
    expect(JSON.stringify(view)).not.toMatch(/6200000|10000000|9000000/);
  });

  // #361 (plan page)
  it("lists own-key runs whose cost is unknown apart, counting those of the own key only", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        keyMode: "own",
        limits: { ownKeyCostLimitMicroUsd: 10_000_000 },
      }),
    );
    await t.use({ state: "settled", keyMode: "own", costMicroUsd: 5_000_000 });
    await t.use({ state: "settled", keyMode: "own", costMicroUsd: null });
    await t.use({ state: "settled", keyMode: "managed", costMicroUsd: null });
    await t.use({
      state: "settled",
      keyMode: "own",
      costMicroUsd: null,
      reservedAt: BEFORE_PERIOD,
    });

    expect(await t.view()).toMatchObject({
      cost: { percentUsed: 50, unknownCostCount: 1 },
    });
  });

  // #361 (plan page)
  it("shows no cost for an own-key workspace whose only cost limit is the managed one, which nothing reads", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        keyMode: "managed",
        limits: { managedCostLimitMicroUsd: 10_000_000 },
      }),
    );
    // The stored shape of before #277 can only be made by hand: switch the key mode under the limit.
    await sql`update workspace_entitlements set key_mode = 'own'`.execute(t.db);
    await t.use({ state: "settled", keyMode: "own", costMicroUsd: 9_000_000 });

    expect(await t.view()).toMatchObject({ kind: "limited", cost: null });
  });

  it("lists a settled run whose cost is unknown apart and does not turn it into zero", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        keyMode: "managed",
        limits: { managedCostLimitMicroUsd: 10_000_000 },
      }),
    );
    await t.use({
      state: "settled",
      keyMode: "managed",
      costMicroUsd: 5_000_000,
    });
    await t.use({
      state: "settled",
      keyMode: "managed",
      costMicroUsd: null,
      settledReason: "no_result",
    });
    await t.use({
      state: "settled",
      keyMode: "managed",
      costMicroUsd: null,
      reservedAt: BEFORE_PERIOD,
    });

    expect(await t.view()).toMatchObject({
      cost: { percentUsed: 50, unknownCostCount: 1 },
    });
  });

  it("answers unreadable for entitlements that cannot be read", async () => {
    const t = await setup();
    await t.entitle(entitlements());
    await sql`update workspace_entitlements set limits = 'not json'`.execute(
      t.db,
    );

    expect(await t.view()).toEqual({ kind: "unreadable" });
    expect(await planPageAvailable(t.db, t.workspaceId)).toBe(true);
  });

  // #282-T08
  it("holds no model, tier, key or job data", async () => {
    const t = await setup();
    await t.entitle(
      entitlements({
        keyMode: "managed",
        limits: { diffRunsPerPeriod: 5, managedCostLimitMicroUsd: 10_000_000 },
      }),
    );
    await t.use({
      state: "settled",
      keyMode: "managed",
      modelTier: "tier-secret-name",
      costMicroUsd: 1_000_000,
      promptTokens: 123456,
      jobResult: { usage: { model: "vendor/secret-model" }, logTail: "log" },
    });

    const text = JSON.stringify(await t.view());

    for (const forbidden of [
      "tier-secret-name",
      "secret-model",
      "123456",
      "logTail",
      "jobId",
      "seeded-job",
      "seeded-record",
      "workspaceId",
    ])
      expect(text).not.toContain(forbidden);
  });
});
