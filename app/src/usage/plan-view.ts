// SPDX-License-Identifier: Apache-2.0

// What the plan page says about a workspace (#282): the resolved entitlements and the counted usage of the current
// period, reduced to what a member may see. Pure: no database, no clock. This is the boundary to the browser, so
// it copies named fields only:
// - run counts against their limit (`null` is no limit),
// - the cost limit as one whole percentage, never an amount of money or a measured cost, in any unit,
// - the plan label, the start of the period and two flags (managed, paused),
// and never the reason of a suspension, where the entitlements came from, a model, a key or anything of a job.
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { ResolvedEntitlements } from "../workspaces/entitlements.ts";

/** What has been counted for the period (`src/usage/usage-summary.ts` reads it; this module only shapes it). */
export type PlanUsage = {
  /** Runs that count towards a limit (`reserved` and `settled`), per review kind. */
  runs: Record<ProjectReviewKind, number>;
  /** The measured cost of the settled runs on the operator's key, micro-USD. Never leaves this module. */
  managedCostMicroUsd: number;
  /** Settled runs on the operator's key whose cost is unknown: the percentage does not include them. */
  managedUnknownCostCount: number;
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
      /** Present only when a cost limit applies to this workspace. */
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
  const costLimit = entitlements.limits.managedCostLimitMicroUsd;
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
    // The claim only watches the cost of a workspace on the operator's key (src/usage/README.md): a limit next
    // to the key mode `own` is read by nothing, so the page does not show it.
    cost:
      managed && costLimit !== null
        ? {
            percentUsed: costPercentUsed(usage.managedCostMicroUsd, costLimit),
            unknownCostCount: usage.managedUnknownCostCount,
          }
        : null,
  };
}
