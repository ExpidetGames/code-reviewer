// SPDX-License-Identifier: Apache-2.0

// What the plan page says about a workspace (#282): the resolved entitlements and the counted usage of the current
// period, reduced to what a member may see. Pure: no database, no clock. This is the boundary to the browser, so
// it copies named fields only:
// - run counts against their limit (`null` is no limit),
// - the cost limit of the key the workspace runs on (the operator's, or its own) as one whole percentage, never an
//   amount of money or a measured cost, in any unit,
// - the plan label, the start of the period and two flags (managed, paused),
// and never the reason of a suspension, where the entitlements came from, a model, a key or anything of a job.
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { ResolvedEntitlements } from "../workspaces/entitlements.ts";

/** What has been counted for the period (`src/usage/usage-summary.ts` reads it; this module only shapes it). */
export type PlanUsage = {
  /** Runs that count towards a limit (`reserved` and `settled`), per review kind. */
  runs: Record<ProjectReviewKind, number>;
  /**
   * The measured cost of the settled runs on the key the workspace runs on (the operator's, or its own),
   * micro-USD. Never leaves this module.
   */
  costMicroUsd: number;
  /** Settled runs on that key whose cost is unknown: the percentage does not include them. */
  unknownCostCount: number;
};

export type RunUsageView = {
  used: number;
  /** `null` is no limit. */
  limit: number | null;
};

export type CostUsageView = {
  /** 0 to 100, rounded down: 100 means the limit is reached (it is a soft cap, so this is not exact). */
  percentUsed: number;
  /** Settled runs whose cost could not be measured; they are not in the percentage. */
  unknownCostCount: number;
};

export type PlanView =
  /** No entitlements: no limits apply. */
  | { kind: "unlimited" }
  /** Entitlements exist but cannot be read; reviews are refused until that is repaired. */
  | { kind: "unreadable" }
  | {
      kind: "limited";
      planLabel: string;
      /** The instance provides the models (the operator's key). */
      managed: boolean;
      /** Reviews are paused for the workspace. */
      suspended: boolean;
      /** ISO 8601 UTC: usage is counted from here. The app does not know when the period ends. */
      periodStart: string;
      runs: Record<ProjectReviewKind, RunUsageView>;
      /** Present only when a cost limit applies to the key this workspace runs on. */
      cost: CostUsageView | null;
    };

/**
 * The whole percentage of the cost limit that is used, rounded down so that 100 means the limit is reached
 * (the claim refuses at `used >= limit`), and at most 100: a run that was in flight when the limit was reached
 * may take the total above it, and the page does not pretend to know by how much. A limit of 0 allows nothing.
 */
export function costPercentUsed(usedMicroUsd: number, limitMicroUsd: number) {
  if (usedMicroUsd >= limitMicroUsd) return 100;
  return Math.floor((usedMicroUsd * 100) / limitMicroUsd);
}

export function buildPlanView(
  entitlements: ResolvedEntitlements,
  usage: PlanUsage,
): PlanView {
  if (entitlements.kind === "unlimited") return { kind: "unlimited" };
  if (entitlements.kind === "invalid") return { kind: "unreadable" };
  const managed = entitlements.keyMode === "managed";
  // The claim watches the limit of the key a job runs on (src/usage/README.md): a limit of the other key mode
  // is read by nothing for this workspace now, so the page does not show it.
  const costLimit = managed
    ? entitlements.limits.managedCostLimitMicroUsd
    : entitlements.limits.ownKeyCostLimitMicroUsd;
  return {
    kind: "limited",
    planLabel: entitlements.planLabel,
    managed,
    suspended: entitlements.suspended,
    periodStart: entitlements.periodStart,
    runs: {
      diff: {
        used: usage.runs.diff,
        limit: entitlements.limits.diffRunsPerPeriod,
      },
      dynamic: {
        used: usage.runs.dynamic,
        limit: entitlements.limits.dynamicRunsPerPeriod,
      },
    },
    cost:
      costLimit === null
        ? null
        : {
            percentUsed: costPercentUsed(usage.costMicroUsd, costLimit),
            unknownCostCount: usage.unknownCostCount,
          },
  };
}
