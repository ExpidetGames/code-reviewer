// SPDX-License-Identifier: Apache-2.0

// What an operator allows a workspace: the key it reviews with, the limits per period and whether its
// reviews are suspended (src/workspaces/README.md, "Entitlements"). The types and the one resolver that
// interprets the stored data; nothing else reads a row or the instance default to decide anything. Pure:
// no database, no clock. The rules for what may be stored are in entitlements-validation.ts.

/** Whose LLM key a workspace's reviews use. `managed` is the operator's key. */
export const KEY_MODES = ["own", "managed"] as const;
export type KeyMode = (typeof KEY_MODES)[number];

/** Every limit is a count (or micro-USD of measured model cost) per period, or null for unlimited. */
export const LIMIT_NAMES = [
  "diffRunsPerPeriod",
  "dynamicRunsPerPeriod",
  "managedCostLimitMicroUsd",
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

/** Where a limited answer came from: the row of the workspace or the default of the instance. */
export type EntitlementsSource = "workspace" | "default";

export type ResolvedEntitlements =
  | { kind: "unlimited" }
  | ({ kind: "limited"; source: EntitlementsSource } & EntitlementsData);

/**
 * The entitlements that apply to a workspace. A row of its own wins entirely, with no field-wise merge with
 * the default; without a row the default applies; with neither the workspace is unlimited, which is what an
 * instance that never configured any of this has always been: the own key, no limits, not suspended.
 */
export function resolveEntitlements(
  row: EntitlementsData | undefined,
  defaultEntitlements: EntitlementsData | undefined,
): ResolvedEntitlements {
  if (row !== undefined)
    return { kind: "limited", source: "workspace", ...row };
  if (defaultEntitlements !== undefined)
    return { kind: "limited", source: "default", ...defaultEntitlements };
  return { kind: "unlimited" };
}
