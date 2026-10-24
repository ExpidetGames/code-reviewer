// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import {
  ENTITLEMENTS_INVALID_CODE,
  type EntitlementLimits,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";
import {
  decideAdmission,
  ENTITLEMENT_REFUSAL_CODES,
  isJobIndependentRefusal,
  readsUsage,
  ignoresCostLimit,
  QUOTA_DETAILS,
  type AdmissionUsage,
} from "./enforce-entitlements.ts";

const PERIOD_START = "2026-10-01T00:00:00.000Z";

function limited(
  overrides: {
    keyMode?: "own" | "managed";
    suspended?: boolean;
    limits?: Partial<EntitlementLimits>;
  } = {},
): ResolvedEntitlements {
  return {
    kind: "limited",
    source: "workspace",
    planLabel: "plan",
    keyMode: overrides.keyMode ?? "own",
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
      ...overrides.limits,
    },
    periodStart: PERIOD_START,
    suspended: overrides.suspended ?? false,
    suspensionCode: overrides.suspended === true ? "overdue" : null,
  };
}

/** A usage source that records what was asked of it. */
function usageOf(
  state: {
    diff?: number;
    dynamic?: number;
    /** The settled cost of the managed records. */
    cost?: number;
    /** The settled cost of the own-key records. */
    ownCost?: number;
  } = {},
): AdmissionUsage & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async runsSince(kind: ProjectReviewKind, since: string) {
      asked.push(`runs:${kind}:${since}`);
      return (kind === "diff" ? state.diff : state.dynamic) ?? 0;
    },
    async costSince(keyMode: "own" | "managed", since: string) {
      asked.push(`cost:${keyMode}:${since}`);
      return (keyMode === "managed" ? state.cost : state.ownCost) ?? 0;
    },
  };
}

describe("deciding whether a claimed job may run", () => {
  // #277-T01
  it("lets everything run, and reads no usage, when the workspace is unlimited", async () => {
    const usage = usageOf({ diff: 1000 });

    const decision = await decideAdmission(
      { kind: "unlimited" },
      "diff",
      usage,
    );

    expect(decision).toEqual({ allow: true });
    expect(usage.asked).toEqual([]);
  });

  // #277-T01
  it("reads no usage when every limit is unlimited and the workspace is not suspended", async () => {
    const usage = usageOf({ diff: 1000 });

    expect(await decideAdmission(limited(), "diff", usage)).toEqual({
      allow: true,
    });
    expect(usage.asked).toEqual([]);
  });

  // #277-T02
  it("refuses a Diff job at or above the Diff limit, and runs it below", async () => {
    const entitlements = limited({ limits: { diffRunsPerPeriod: 2 } });

    expect(
      await decideAdmission(entitlements, "diff", usageOf({ diff: 1 })),
    ).toEqual({ allow: true });
    expect(
      await decideAdmission(entitlements, "diff", usageOf({ diff: 2 })),
    ).toEqual({
      allow: false,
      errorCode: "quota_exhausted",
      detail: "diff_runs",
      periodStart: PERIOD_START,
    });
    expect(
      await decideAdmission(entitlements, "diff", usageOf({ diff: 3 })),
    ).toMatchObject({ allow: false, detail: "diff_runs" });
  });

  // #277-T02
  it("counts runs since the start of the period, of the kind of the job only", async () => {
    const usage = usageOf({ diff: 5, dynamic: 0 });

    await decideAdmission(
      limited({ limits: { diffRunsPerPeriod: 9, dynamicRunsPerPeriod: 1 } }),
      "dynamic",
      usage,
    );

    expect(usage.asked).toEqual([`runs:dynamic:${PERIOD_START}`]);
  });

  // #277-T03
  it("refuses every job of a kind whose limit is 0, and leaves the other kind alone", async () => {
    const entitlements = limited({ limits: { dynamicRunsPerPeriod: 0 } });

    expect(await decideAdmission(entitlements, "dynamic", usageOf())).toEqual({
      allow: false,
      errorCode: "quota_exhausted",
      detail: "dynamic_runs",
      periodStart: PERIOD_START,
    });
    expect(await decideAdmission(entitlements, "diff", usageOf())).toEqual({
      allow: true,
    });
  });

  // #277-T04
  it("refuses a managed job at or above the cost limit, and leaves a job on the own key alone", async () => {
    const limits = { managedCostLimitMicroUsd: 5_000_000 };

    expect(
      await decideAdmission(
        limited({ keyMode: "managed", limits }),
        "diff",
        usageOf({ cost: 4_999_999 }),
      ),
    ).toEqual({ allow: true });
    expect(
      await decideAdmission(
        limited({ keyMode: "managed", limits }),
        "diff",
        usageOf({ cost: 5_000_000 }),
      ),
    ).toEqual({
      allow: false,
      errorCode: "quota_exhausted",
      detail: "managed_cost",
      periodStart: PERIOD_START,
    });
    const own = usageOf({ cost: 9_000_000 });
    expect(
      await decideAdmission(limited({ keyMode: "own", limits }), "diff", own),
    ).toEqual({ allow: true });
    expect(own.asked).toEqual([]);
  });

  // #277-T04
  it("refuses every managed job when the cost limit is 0", async () => {
    expect(
      await decideAdmission(
        limited({
          keyMode: "managed",
          limits: { managedCostLimitMicroUsd: 0 },
        }),
        "diff",
        usageOf(),
      ),
    ).toMatchObject({ allow: false, detail: "managed_cost" });
  });

  // #361-T02
  it("refuses an own-key job at or above the own-key cost limit, and runs it below", async () => {
    const entitlements = limited({
      keyMode: "own",
      limits: { ownKeyCostLimitMicroUsd: 5_000_000 },
    });

    expect(
      await decideAdmission(
        entitlements,
        "diff",
        usageOf({ ownCost: 4_999_999 }),
      ),
    ).toEqual({ allow: true });
    expect(
      await decideAdmission(
        entitlements,
        "diff",
        usageOf({ ownCost: 5_000_000 }),
      ),
    ).toEqual({
      allow: false,
      errorCode: "quota_exhausted",
      detail: "own_key_cost",
      periodStart: PERIOD_START,
    });
  });

  // #361-T03
  it("reads the cost of the key mode the job runs on and the limit of that mode only", async () => {
    const limits = {
      managedCostLimitMicroUsd: 5_000_000,
      ownKeyCostLimitMicroUsd: 1,
    };
    const managed = usageOf({ cost: 0, ownCost: 9_000_000 });
    const own = usageOf({ cost: 9_000_000, ownCost: 0 });

    // The managed cost limit does not block an own-key job, and the own-key limit does not block a managed one.
    expect(
      await decideAdmission(
        limited({ keyMode: "managed", limits }),
        "diff",
        managed,
      ),
    ).toEqual({ allow: true });
    expect(managed.asked).toEqual([`cost:managed:${PERIOD_START}`]);
    expect(
      await decideAdmission(
        limited({ keyMode: "own", limits: { ownKeyCostLimitMicroUsd: 1 } }),
        "diff",
        own,
      ),
    ).toEqual({ allow: true });
    expect(own.asked).toEqual([`cost:own:${PERIOD_START}`]);
  });

  // #361-T06
  it("refuses every own-key job when the own-key cost limit is 0, and reads no usage for null", async () => {
    expect(
      await decideAdmission(
        limited({ keyMode: "own", limits: { ownKeyCostLimitMicroUsd: 0 } }),
        "diff",
        usageOf(),
      ),
    ).toMatchObject({ allow: false, detail: "own_key_cost" });
    const unlimited = usageOf({ ownCost: 9_000_000 });
    expect(
      await decideAdmission(
        limited({ keyMode: "own", limits: { ownKeyCostLimitMicroUsd: null } }),
        "diff",
        unlimited,
      ),
    ).toEqual({ allow: true });
    expect(unlimited.asked).toEqual([]);
  });

  // #361-T05
  it("decides the run count before the own-key cost", async () => {
    expect(
      await decideAdmission(
        limited({
          limits: { diffRunsPerPeriod: 1, ownKeyCostLimitMicroUsd: 1 },
        }),
        "diff",
        usageOf({ diff: 1, ownCost: 1 }),
      ),
    ).toMatchObject({ allow: false, detail: "diff_runs" });
  });

  // #277-T05
  it("refuses a suspended workspace first, whatever its usage and limits", async () => {
    const usage = usageOf({ diff: 100, cost: 100 });

    expect(
      await decideAdmission(
        limited({
          suspended: true,
          keyMode: "managed",
          limits: { diffRunsPerPeriod: 1, managedCostLimitMicroUsd: 1 },
        }),
        "diff",
        usage,
      ),
    ).toEqual({
      allow: false,
      errorCode: "workspace_suspended",
      periodStart: PERIOD_START,
    });
    expect(usage.asked).toEqual([]);
  });

  // #277-T05
  it("refuses a job of a suspended workspace that has no limits at all", async () => {
    expect(
      await decideAdmission(limited({ suspended: true }), "dynamic", usageOf()),
    ).toEqual({
      allow: false,
      errorCode: "workspace_suspended",
      periodStart: PERIOD_START,
    });
  });

  // #277-T02
  it("decides the run count before the cost", async () => {
    expect(
      await decideAdmission(
        limited({
          keyMode: "managed",
          limits: { diffRunsPerPeriod: 1, managedCostLimitMicroUsd: 1 },
        }),
        "diff",
        usageOf({ diff: 1, cost: 1 }),
      ),
    ).toMatchObject({ allow: false, detail: "diff_runs" });
  });

  // #271 follow-up: unreadable entitlements fail closed
  it("refuses with the code of the resolver when the entitlements cannot be read, and never lets the job run", async () => {
    const usage = usageOf();

    expect(
      await decideAdmission(
        {
          kind: "invalid",
          code: ENTITLEMENTS_INVALID_CODE,
          source: "workspace",
        },
        "diff",
        usage,
      ),
    ).toEqual({ allow: false, errorCode: "entitlements_invalid" });
    expect(usage.asked).toEqual([]);
  });

  // #277-T12
  it("only ever names the stable codes and details that are listed", () => {
    expect(ENTITLEMENT_REFUSAL_CODES).toEqual([
      "workspace_suspended",
      "quota_exhausted",
      "entitlements_invalid",
    ]);
    expect(QUOTA_DETAILS).toEqual([
      "diff_runs",
      "dynamic_runs",
      "managed_cost",
      "own_key_cost",
    ]);
  });
});

describe("which entitlements need the usage of the workspace", () => {
  // #277-P3
  it("needs none for an unlimited workspace, for no limits, and for a suspended or unreadable one", () => {
    const invalid: ResolvedEntitlements = {
      kind: "invalid",
      code: ENTITLEMENTS_INVALID_CODE,
      source: "workspace",
    };

    expect(readsUsage({ kind: "unlimited" }, "diff")).toBe(false);
    expect(readsUsage(limited(), "diff")).toBe(false);
    expect(readsUsage(invalid, "diff")).toBe(false);
    expect(
      readsUsage(
        limited({ suspended: true, limits: { diffRunsPerPeriod: 1 } }),
        "diff",
      ),
    ).toBe(false);
  });

  // #361-T06
  it("needs it for the own-key cost limit of an own key, and not for one next to the managed key", () => {
    const cost = { ownKeyCostLimitMicroUsd: 1 };

    expect(readsUsage(limited({ keyMode: "own", limits: cost }), "diff")).toBe(
      true,
    );
    expect(
      readsUsage(limited({ keyMode: "managed", limits: cost }), "diff"),
    ).toBe(false);
    expect(
      readsUsage(
        limited({ keyMode: "own", limits: { ownKeyCostLimitMicroUsd: null } }),
        "diff",
      ),
    ).toBe(false);
  });

  // #277-P3
  it("needs it for the limit of the kind of the job, and for the cost limit of a managed key only", () => {
    const diff = limited({ limits: { diffRunsPerPeriod: 1 } });
    const cost = { managedCostLimitMicroUsd: 1 };

    expect(readsUsage(diff, "diff")).toBe(true);
    expect(readsUsage(diff, "dynamic")).toBe(false);
    expect(
      readsUsage(limited({ keyMode: "managed", limits: cost }), "diff"),
    ).toBe(true);
    expect(readsUsage(limited({ keyMode: "own", limits: cost }), "diff")).toBe(
      false,
    );
  });

  // #277-P2
  it("says that a cost limit next to the own key is ignored", () => {
    const cost = { managedCostLimitMicroUsd: 0 };

    expect(ignoresCostLimit(limited({ keyMode: "own", limits: cost }))).toBe(
      true,
    );
    expect(
      ignoresCostLimit(limited({ keyMode: "managed", limits: cost })),
    ).toBe(false);
    expect(ignoresCostLimit(limited({ keyMode: "own" }))).toBe(false);
    expect(ignoresCostLimit({ kind: "unlimited" })).toBe(false);
  });

  // #277-P2
  it("treats a suspension and unreadable entitlements as refusals that do not depend on the job", () => {
    expect(isJobIndependentRefusal("workspace_suspended")).toBe(true);
    expect(isJobIndependentRefusal("entitlements_invalid")).toBe(true);
    expect(isJobIndependentRefusal("quota_exhausted")).toBe(false);
  });
});

describe("the run quotas while billing is on (#499)", () => {
  // #499-T08
  it("does not refuse a job of a kind whose run limit is 0 when run quotas are not enforced", async () => {
    const usage = usageOf({ diff: 5 });

    const decision = await decideAdmission(
      limited({ limits: { diffRunsPerPeriod: 0, dynamicRunsPerPeriod: 0 } }),
      "diff",
      usage,
      { runQuotas: false },
    );

    expect(decision).toEqual({ allow: true });
    expect(usage.asked).toEqual([]);
  });

  // #499-T08
  it("still refuses a suspended workspace and unreadable entitlements when run quotas are not enforced", async () => {
    const suspended = await decideAdmission(
      limited({ suspended: true }),
      "diff",
      usageOf(),
      { runQuotas: false },
    );
    const unreadable = await decideAdmission(
      { kind: "invalid", code: ENTITLEMENTS_INVALID_CODE, source: "workspace" },
      "diff",
      usageOf(),
      { runQuotas: false },
    );

    expect(suspended).toMatchObject({
      allow: false,
      errorCode: "workspace_suspended",
    });
    expect(unreadable).toMatchObject({
      allow: false,
      errorCode: ENTITLEMENTS_INVALID_CODE,
    });
  });

  // #499-T11
  it("still refuses at the cost limit of the key when run quotas are not enforced", async () => {
    const own = await decideAdmission(
      limited({
        keyMode: "own",
        limits: { diffRunsPerPeriod: 0, ownKeyCostLimitMicroUsd: 1_000 },
      }),
      "diff",
      usageOf({ ownCost: 1_000 }),
      { runQuotas: false },
    );
    const managed = await decideAdmission(
      limited({
        keyMode: "managed",
        limits: { diffRunsPerPeriod: 0, managedCostLimitMicroUsd: 1_000 },
      }),
      "diff",
      usageOf({ cost: 1_000 }),
      { runQuotas: false },
    );

    expect(own).toMatchObject({
      allow: false,
      errorCode: "quota_exhausted",
      detail: "own_key_cost",
    });
    expect(managed).toMatchObject({
      allow: false,
      errorCode: "quota_exhausted",
      detail: "managed_cost",
    });
  });

  // #499-T09
  it("enforces the run limit as before when nothing is said about run quotas", async () => {
    const decision = await decideAdmission(
      limited({ limits: { diffRunsPerPeriod: 0 } }),
      "diff",
      usageOf(),
    );

    expect(decision).toMatchObject({
      allow: false,
      errorCode: "quota_exhausted",
      detail: "diff_runs",
    });
  });

  // #499-T08
  it("reads no usage for a run limit when run quotas are not enforced, and only for the cost limit that applies", () => {
    const entitlements = limited({
      limits: { diffRunsPerPeriod: 3, ownKeyCostLimitMicroUsd: null },
    });

    expect(readsUsage(entitlements, "diff")).toBe(true);
    expect(readsUsage(entitlements, "diff", { runQuotas: false })).toBe(false);
    expect(
      readsUsage(
        limited({
          limits: { diffRunsPerPeriod: 3, ownKeyCostLimitMicroUsd: 5 },
        }),
        "diff",
        { runQuotas: false },
      ),
    ).toBe(true);
  });
});
