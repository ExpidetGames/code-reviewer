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

/**
 * Which catalog entries a workspace on the operator's key may use (#428, ADR 0005, 2.9): the ids of the entries, `[]` for
 * none, `null` for every released entry. It has a meaning for the key mode `managed` only; next to `own` it is kept,
 * and nothing reads it.
 */
export type ModelAccess = { catalogEntries: string[] | null };

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
  /**
   * Absent means every released entry, like `{ catalogEntries: null }`. A stored entry always carries it once read
   * (`readEntitlements`); the type lets a writer that does not know the field leave it out.
   */
  modelAccess?: ModelAccess;
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
  /**
   * No entitlements: no limit, not suspended. `keyMode` is set only by the workspace's own choice while billing is on
   * (`applyWorkspaceKeyMode`, src/workspaces/effective-key-mode.ts); absent, the key is the workspace's own.
   */
  | { kind: "unlimited"; keyMode?: KeyMode }
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
    ...(entry.modelAccess === undefined
      ? {}
      : {
          modelAccess: {
            catalogEntries:
              entry.modelAccess.catalogEntries === null
                ? null
                : [...entry.modelAccess.catalogEntries],
          },
        }),
  };
}

/**
 * What a workspace without entitlements looks like to the code that wants a limited entry (the model selection of a managed
 * job, #496): no limit, not suspended, every released catalog entry (no `modelAccess`). Billing on gives such a workspace the
 * managed key mode, and the selection reads its model access from this shape.
 */
export function noLimits(
  keyMode: KeyMode,
): Extract<ResolvedEntitlements, { kind: "limited" }> {
  return {
    kind: "limited",
    source: "default",
    planLabel: "",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: new Date(0).toISOString(),
    suspended: false,
    suspensionCode: null,
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

/**
 * Whether the entitlements let a workspace use a catalog entry: the one question the claim and the picker ask (#428), so
 * they cannot answer it differently. No entitlements, `null` and an absent field allow every entry, a list allows the
 * entries on it, `[]` allows none, and an id on the list that no entry has matches nothing. Unreadable entitlements
 * allow nothing: damaged data does not grant a model.
 *
 * It answers about the list only. That an entry is released and serves the kind is for the caller to check, and so is
 * the key mode: a workspace on its own key reads no catalog, so its caller never asks (#432).
 */
export function entryAllowed(
  entitlements: ResolvedEntitlements,
  entry: { id: string },
): boolean {
  if (entitlements.kind === "unlimited") return true;
  if (entitlements.kind === "invalid") return false;
  const listed = entitlements.modelAccess?.catalogEntries ?? null;
  return listed === null || listed.includes(entry.id);
}
