// SPDX-License-Identifier: Apache-2.0

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
      ...overrides.limits,
    },
    periodStart: PERIOD_START,
    suspended: overrides.suspended ?? false,
    suspensionCode: overrides.suspended === true ? "overdue" : null,
  };
}

/** A usage source that records what was asked of it. */
function usageOf(
  state: { diff?: number; dynamic?: number; cost?: number } = {},
): AdmissionUsage & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async runsSince(kind: ProjectReviewKind, since: string) {
      asked.push(`runs:${kind}:${since}`);
      return (kind === "diff" ? state.diff : state.dynamic) ?? 0;
    },
    async managedCostSince(since: string) {
      asked.push(`cost:${since}`);
      return state.cost ?? 0;
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
    ).toEqual({ allow: false, errorCode: "workspace_suspended" });
    expect(usage.asked).toEqual([]);
  });

  // #277-T05
  it("refuses a job of a suspended workspace that has no limits at all", async () => {
    expect(
      await decideAdmission(limited({ suspended: true }), "dynamic", usageOf()),
    ).toEqual({ allow: false, errorCode: "workspace_suspended" });
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
    ]);
  });
});
