// SPDX-License-Identifier: LicenseRef-Proprietary

// What the plan page may say about a workspace (#282): the view is built from the resolved entitlements and
// the counted usage, and only counts, one whole percentage, a label, flags and a start date leave it. The cost
// limit is shown as a percentage of the limit, never as an amount.
import { describe, expect, it } from "vitest";
import type { ResolvedEntitlements } from "../workspaces/entitlements.ts";
import { buildPlanView, costPercentUsed, type PlanUsage } from "./plan-view.ts";

const NO_USAGE: PlanUsage = {
  runs: { diff: 0, dynamic: 0 },
  costMicroUsd: 0,
  unknownCostCount: 0,
};

function limited(
  overrides: Partial<Extract<ResolvedEntitlements, { kind: "limited" }>> = {},
): ResolvedEntitlements {
  return {
    kind: "limited",
    source: "workspace",
    planLabel: "Team",
    keyMode: "own",
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

function ownKeyWithCostLimit(limit: number | null) {
  return limited({
    keyMode: "own",
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: limit,
    },
  });
}

function managedWithCostLimit(limit: number | null) {
  return limited({
    keyMode: "managed",
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: limit,
      ownKeyCostLimitMicroUsd: null,
    },
  });
}

describe("the percentage of the cost limit used", () => {
  // #282-T04
  it("is the whole percentage, rounded down, so 100 means the limit is reached", () => {
    expect(costPercentUsed(620_000, 1_000_000)).toBe(62);
    expect(costPercentUsed(629_999, 1_000_000)).toBe(62);
    expect(costPercentUsed(999_999, 1_000_000)).toBe(99);
    expect(costPercentUsed(1_000_000, 1_000_000)).toBe(100);
  });

  it("stops at 100 when the soft cap was overshot by runs that were in flight", () => {
    expect(costPercentUsed(1_700_000, 1_000_000)).toBe(100);
  });

  it("is 0 when nothing is used and 100 for a limit of 0, which allows nothing", () => {
    expect(costPercentUsed(0, 1_000_000)).toBe(0);
    expect(costPercentUsed(0, 0)).toBe(100);
  });
});

describe("the plan view", () => {
  it("is unlimited for a workspace without entitlements", () => {
    expect(buildPlanView({ kind: "unlimited" }, NO_USAGE)).toEqual({
      kind: "unlimited",
    });
  });

  it("says unreadable for entitlements that cannot be read, and nothing else", () => {
    expect(
      buildPlanView(
        { kind: "invalid", code: "entitlements_invalid", source: "workspace" },
        NO_USAGE,
      ),
    ).toEqual({ kind: "unreadable" });
  });

  // #282-T02, #282-T03
  it("counts the runs of each kind against its limit, and null stays no limit", () => {
    const view = buildPlanView(
      limited({
        limits: {
          diffRunsPerPeriod: 5,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
      { ...NO_USAGE, runs: { diff: 3, dynamic: 1 } },
    );

    expect(view).toMatchObject({
      kind: "limited",
      runs: {
        diff: { used: 3, limit: 5 },
        dynamic: { used: 1, limit: null },
      },
    });
  });

  it("carries the plan label, the start of the period and whether the instance provides the models", () => {
    const view = buildPlanView(
      limited({ planLabel: "Team", keyMode: "managed" }),
      NO_USAGE,
    );

    expect(view).toMatchObject({
      planLabel: "Team",
      managed: true,
      periodStart: "2026-10-01T00:00:00.000Z",
    });
    expect(buildPlanView(limited(), NO_USAGE)).toMatchObject({
      managed: false,
    });
  });

  // #282-T06
  it("says that reviews are paused and never why", () => {
    const view = buildPlanView(
      limited({ suspended: true, suspensionCode: "overdue" }),
      NO_USAGE,
    );

    expect(view).toMatchObject({ suspended: true });
    expect(JSON.stringify(view)).not.toContain("overdue");
    expect(JSON.stringify(view)).not.toContain("suspensionCode");
  });

  // #282-T04
  it("shows the cost limit as a percentage and the runs whose cost is unknown, never an amount", () => {
    const view = buildPlanView(managedWithCostLimit(5_000_000), {
      ...NO_USAGE,
      costMicroUsd: 3_100_000,
      unknownCostCount: 2,
    });

    expect(view).toMatchObject({
      cost: { percentUsed: 62, unknownCostCount: 2 },
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain("3100000");
    expect(text).not.toContain("5000000");
    expect(text).not.toContain("MicroUsd");
  });

  it("has no cost when there is no cost limit", () => {
    expect(buildPlanView(managedWithCostLimit(null), NO_USAGE)).toMatchObject({
      cost: null,
    });
  });

  it("has no cost for a workspace on its own key, whose cost limit nothing reads", () => {
    const view = buildPlanView(
      limited({
        keyMode: "own",
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: 1_000_000,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
      { ...NO_USAGE, costMicroUsd: 900_000 },
    );

    expect(view).toMatchObject({ cost: null });
  });

  // #361 (plan page): the bar for the limit of the own key
  it("shows the own-key cost limit as a percentage, with the runs whose cost is unknown apart, never an amount", () => {
    const view = buildPlanView(ownKeyWithCostLimit(5_000_000), {
      ...NO_USAGE,
      costMicroUsd: 3_100_000,
      unknownCostCount: 2,
    });

    expect(view).toMatchObject({
      managed: false,
      cost: { percentUsed: 62, unknownCostCount: 2 },
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain("3100000");
    expect(text).not.toContain("5000000");
    expect(text).not.toContain("MicroUsd");
  });

  it("rounds the own-key percentage down, caps it at 100 and reads a limit of 0 as 100", () => {
    const at = (used: number, limit: number) =>
      buildPlanView(ownKeyWithCostLimit(limit), {
        ...NO_USAGE,
        costMicroUsd: used,
      });

    expect(at(999_999, 1_000_000)).toMatchObject({ cost: { percentUsed: 99 } });
    expect(at(1_000_000, 1_000_000)).toMatchObject({
      cost: { percentUsed: 100 },
    });
    expect(at(7_000_000, 1_000_000)).toMatchObject({
      cost: { percentUsed: 100 },
    });
    expect(at(0, 0)).toMatchObject({ cost: { percentUsed: 100 } });
  });

  it("has no cost for an own-key workspace without an own-key cost limit", () => {
    expect(buildPlanView(ownKeyWithCostLimit(null), NO_USAGE)).toMatchObject({
      cost: null,
    });
  });

  it("shows only the limit of the key the workspace runs on", () => {
    const both = {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: 4_000_000,
      ownKeyCostLimitMicroUsd: 8_000_000,
    };
    const usage = { ...NO_USAGE, costMicroUsd: 2_000_000 };

    expect(
      buildPlanView(limited({ keyMode: "managed", limits: both }), usage),
    ).toMatchObject({ cost: { percentUsed: 50 } });
    expect(
      buildPlanView(limited({ keyMode: "own", limits: both }), usage),
    ).toMatchObject({ cost: { percentUsed: 25 } });
    // Only the other mode's limit is set: nothing applies to the key the workspace runs on.
    expect(
      buildPlanView(
        limited({
          keyMode: "managed",
          limits: { ...both, managedCostLimitMicroUsd: null },
        }),
        usage,
      ),
    ).toMatchObject({ cost: null });
  });

  it("does not hand on where the entitlements came from", () => {
    const view = buildPlanView(limited({ source: "default" }), NO_USAGE);

    expect(JSON.stringify(view)).not.toContain("default");
    expect(JSON.stringify(view)).not.toContain("source");
  });
});

describe("the plan view while billing is on (#499)", () => {
  // #499-T10
  it("has no run counts, whatever the plan says, but keeps the cost limit and the rest", () => {
    const view = buildPlanView(
      limited({
        keyMode: "managed",
        limits: {
          diffRunsPerPeriod: 5,
          dynamicRunsPerPeriod: 2,
          managedCostLimitMicroUsd: 1_000_000,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
      {
        runs: { diff: 5, dynamic: 2 },
        costMicroUsd: 250_000,
        unknownCostCount: 0,
      },
      { runQuotas: false },
    );

    expect(view).toEqual({
      kind: "limited",
      planLabel: "Team",
      managed: true,
      suspended: false,
      periodStart: "2026-10-01T00:00:00.000Z",
      runs: null,
      cost: { percentUsed: 25, unknownCostCount: 0 },
    });
  });

  // #499-T10
  it("keeps the run counts when nothing is said about billing", () => {
    const view = buildPlanView(
      limited({
        limits: {
          diffRunsPerPeriod: 5,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
      { ...NO_USAGE, runs: { diff: 3, dynamic: 0 } },
    );

    expect(view).toMatchObject({ runs: { diff: { used: 3, limit: 5 } } });
  });
});
