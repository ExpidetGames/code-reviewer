// SPDX-License-Identifier: Apache-2.0

// What an operator allows a workspace: the key it reviews with, the limits per period and whether its
// reviews are suspended (src/workspaces/README.md, "Entitlements"). The types and the one resolver that
// interprets the stored data; nothing else reads a row or the instance default to decide anything. Pure:
// no database, no clock. The rules for what may be stored are in entitlements-validation.ts.

/** Whose LLM key a workspace's reviews use. `managed` is the operator's key. */
export const KEY_MODES = ["own", "managed"] as const;
export type KeyMode = (typeof KEY_MODES)[number];

/**
 * Every limit is a count (or micro-USD of measured model cost) per period, or null for unlimited. The two cost
 * limits watch one key mode each: `managedCostLimitMicroUsd` the runs on the operator's key,
 * `ownKeyCostLimitMicroUsd` the runs on the workspace's own key (#361).
 */
export const LIMIT_NAMES = [
  "diffRunsPerPeriod",
  "dynamicRunsPerPeriod",
  "managedCostLimitMicroUsd",
  "ownKeyCostLimitMicroUsd",
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
export type EntitlementLimits = Record<LimitName, number | null>;

/** The fields of a workspace row and of the instance default (`default_entitlements`) alike. */
export type EntitlementsData = {
  /** A label for display and audit; the code never branches on it. */
  planLabel: string;
  keyMode: KeyMode;
  limits: EntitlementLimits;
  /** ISO 8601 UTC with milliseconds: usage counts from here. */
  periodStart: string;
  suspended: boolean;
  /** A short lowercase code that says why; null unless suspended. */
  suspensionCode: string | null;
};

/** Where an answer came from: the row of the workspace or the default of the instance. */
export type EntitlementsSource = "workspace" | "default";

/**
 * A stored entry (a row, or the default) that could not be read: damaged JSON, or data the validation of
 * `entitlements-validation.ts` refuses. The repositories hand this over instead of throwing, so a damaged
 * entry cannot stall the caller and cannot pass for "no entry".
 */
export type InvalidEntitlements = { invalid: true };
export const INVALID_ENTITLEMENTS: InvalidEntitlements = { invalid: true };

/** What a repository holds for a workspace or as the default: readable data, or an entry that is not. */
export type EntitlementsEntry = EntitlementsData | InvalidEntitlements;

/** The one code of an unreadable entry; whoever enforces limits (#277) refuses with it. */
export const ENTITLEMENTS_INVALID_CODE = "entitlements_invalid";

export type ResolvedEntitlements =
  | { kind: "unlimited" }
  | ({ kind: "limited"; source: EntitlementsSource } & EntitlementsData)
  | {
      kind: "invalid";
      code: typeof ENTITLEMENTS_INVALID_CODE;
      source: EntitlementsSource;
    };

function limited(
  source: EntitlementsSource,
  entry: EntitlementsEntry,
): ResolvedEntitlements {
  if ("invalid" in entry)
    return { kind: "invalid", code: ENTITLEMENTS_INVALID_CODE, source };
  // Named fields only: a stored row also carries who saved it and when, which must not travel with the
  // answer (it ends up in logs and in the operator API).
  return {
    kind: "limited",
    source,
    planLabel: entry.planLabel,
    keyMode: entry.keyMode,
    limits: {
      diffRunsPerPeriod: entry.limits.diffRunsPerPeriod,
      dynamicRunsPerPeriod: entry.limits.dynamicRunsPerPeriod,
      managedCostLimitMicroUsd: entry.limits.managedCostLimitMicroUsd,
      ownKeyCostLimitMicroUsd: entry.limits.ownKeyCostLimitMicroUsd,
    },
    periodStart: entry.periodStart,
    suspended: entry.suspended,
    suspensionCode: entry.suspensionCode,
  };
}

/**
 * The entitlements that apply to a workspace. A row of its own wins entirely, with no field-wise merge with
 * the default; without a row the default applies; with neither the workspace is unlimited, which is what an
 * instance that never configured any of this has always been: the own key, no limits, not suspended.
 *
 * An entry that exists but could not be read resolves to `invalid` and never to `unlimited`: damaged data
 * does not lift a limit. The caller that enforces (#277) refuses with the code; it does not throw.
 */
export function resolveEntitlements(
  row: EntitlementsEntry | undefined,
  defaultEntitlements: EntitlementsEntry | undefined,
): ResolvedEntitlements {
  if (row !== undefined) return limited("workspace", row);
  if (defaultEntitlements !== undefined)
    return limited("default", defaultEntitlements);
  return { kind: "unlimited" };
}
