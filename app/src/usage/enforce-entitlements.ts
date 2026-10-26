// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether a claimed job may run, given what an operator allows the workspace (src/workspaces/entitlements.ts)
// and what it used in the period (src/usage/README.md, "Limits"). Pure: the usage is read through a small
// interface, and only as far as the answer needs it, so a workspace without limits reads nothing. The queue's claim
// (src/db/repositories/claim-admission.ts) feeds it inside the transaction that reserves the usage record.
import type { JobErrorCode } from "../jobs/job-types.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import {
  ENTITLEMENTS_INVALID_CODE,
  type EntitlementLimits,
  type KeyMode,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";

/** The codes a job ends with when the claim refuses it. Branch on these; the Runs pages translate them. */
export const ENTITLEMENT_REFUSAL_CODES = [
  "workspace_suspended",
  "quota_exhausted",
  ENTITLEMENTS_INVALID_CODE,
] as const satisfies readonly JobErrorCode[];
export type EntitlementRefusalCode = (typeof ENTITLEMENT_REFUSAL_CODES)[number];

/** Which limit a `quota_exhausted` refusal is about. It is logged, not stored: the code is all a person is told. */
export const QUOTA_DETAILS = [
  "diff_runs",
  "dynamic_runs",
  "managed_cost",
  "own_key_cost",
] as const;
export type QuotaDetail = (typeof QUOTA_DETAILS)[number];

/**
 * `periodStart` is the start of the period the refusal was decided under (#281: the pull request notice is once
 * per pull request and period). Unreadable entitlements have none: they have no period.
 */
export type Admission =
  | { allow: true }
  | {
      allow: false;
      errorCode: EntitlementRefusalCode;
      detail?: QuotaDetail;
      periodStart?: string;
    };

/** What the workspace used since the start of its period; each read is one indexed query in the database. */
export type AdmissionUsage = {
  /** Records of the kind that count (`reserved` and `settled`) reserved at or after `since`. */
  runsSince(kind: ProjectReviewKind, since: string): Promise<number>;
  /**
   * The known cost of the settled records of `keyMode` reserved at or after `since`, micro-USD. A record counts
   * under its own key mode, not the one the entitlements say now (#361).
   */
  costSince(keyMode: KeyMode, since: string): Promise<number>;
};

/**
 * The cost limit that watches a key mode, and the detail of its refusal. A run is bounded by the limit of the key
 * it runs on, so the two never block each other (#361).
 */
const COST_LIMIT_OF_KEY_MODE = {
  managed: { limit: "managedCostLimitMicroUsd", detail: "managed_cost" },
  own: { limit: "ownKeyCostLimitMicroUsd", detail: "own_key_cost" },
} as const satisfies Record<
  KeyMode,
  { limit: keyof EntitlementLimits; detail: QuotaDetail }
>;

const RUN_LIMIT_OF_KIND = {
  diff: { limit: "diffRunsPerPeriod", detail: "diff_runs" },
  dynamic: { limit: "dynamicRunsPerPeriod", detail: "dynamic_runs" },
} as const satisfies Record<
  ProjectReviewKind,
  { limit: string; detail: QuotaDetail }
>;

/**
 * What the claim says about the circumstances of a decision. `runQuotas: false` is billing being on (ADR 0006, D5; #499): the run
 * limits of the plan (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`) are not enforced then, whatever the entitlements hold. The
 * suspension, unreadable entitlements and the cost limits are, as ever. Absent or true: everything is enforced, billing off.
 */
export type AdmissionOptions = { runQuotas?: boolean };

/**
 * Whether deciding needs the usage of the workspace at all: only a limit that applies to this job reads it. A
 * workspace that is unlimited, suspended, unreadable or without a limit for this kind (and, for the cost limit,
 * without the operator's key) needs no count and no lock.
 */
export function readsUsage(
  entitlements: ResolvedEntitlements,
  reviewKind: ProjectReviewKind,
  options: AdmissionOptions = {},
): boolean {
  if (entitlements.kind !== "limited" || entitlements.suspended) return false;
  const { limits } = entitlements;
  if (
    options.runQuotas !== false &&
    limits[RUN_LIMIT_OF_KIND[reviewKind].limit] !== null
  )
    return true;
  return limits[COST_LIMIT_OF_KEY_MODE[entitlements.keyMode].limit] !== null;
}

/**
 * A managed cost limit stored next to the own key: nothing reads it (the own key has `ownKeyCostLimitMicroUsd`).
 * An operator can no longer write that shape (`cost_limit_requires_managed_key`), but an entry stored earlier
 * keeps working and the limit is ignored.
 */
export function ignoresCostLimit(entitlements: ResolvedEntitlements): boolean {
  return (
    entitlements.kind === "limited" &&
    entitlements.keyMode === "own" &&
    entitlements.limits.managedCostLimitMicroUsd !== null
  );
}

/**
 * A refusal that does not depend on the job: the answer is the same for every job of the workspace, so the
 * claim fails all of its due jobs at once instead of one per round.
 */
export function isJobIndependentRefusal(code: EntitlementRefusalCode): boolean {
  return code === "workspace_suspended" || code === ENTITLEMENTS_INVALID_CODE;
}

/**
 * The part of the admission that is about the workspace's standing and not about what it used: unreadable entitlements
 * and a suspension, in the order of `decideAdmission`. A caller that decided the quotas already (the Worker's fetch,
 * which runs after the claim, #276) asks only this before it hands out a credential; it needs no count and no lock.
 */
export function standingRefusal(
  entitlements: ResolvedEntitlements,
): "entitlements_invalid" | "workspace_suspended" | null {
  if (entitlements.kind === "invalid") return entitlements.code;
  if (entitlements.kind === "limited" && entitlements.suspended)
    return "workspace_suspended";
  return null;
}

function exhausted(detail: QuotaDetail, periodStart: string): Admission {
  return { allow: false, errorCode: "quota_exhausted", detail, periodStart };
}

/**
 * The decision, in this order, the first refusal wins:
 *
 * 1. entitlements that cannot be read: refused (`entitlements_invalid`), never read as unlimited;
 * 2. a suspended workspace: `workspace_suspended`;
 * 3. the run limit of the job's kind: the runs of that kind in the period at or above it (0 allows none) refuse; skipped
 *    while billing is on (`options.runQuotas === false`, #499);
 * 4. the cost limit of the key the job runs on: `managedCostLimitMicroUsd` for the operator's key,
 *    `ownKeyCostLimitMicroUsd` for the workspace's own (#361). The key is the one the entitlements pick (the
 *    claim route resolves the access the same way), and the sum counts the settled records of that key mode in
 *    the period; at or above the limit refuses. A run with an unknown cost adds nothing to the sum (it still
 *    counts in 3). The limit is a soft cap: runs in flight are not in the sum.
 *
 * A limit of `null` is not read at all.
 */
export async function decideAdmission(
  entitlements: ResolvedEntitlements,
  reviewKind: ProjectReviewKind,
  usage: AdmissionUsage,
  options: AdmissionOptions = {},
): Promise<Admission> {
  if (entitlements.kind === "unlimited") return { allow: true };
  if (entitlements.kind === "invalid")
    return { allow: false, errorCode: entitlements.code };
  if (entitlements.suspended)
    return {
      allow: false,
      errorCode: "workspace_suspended",
      periodStart: entitlements.periodStart,
    };

  const { periodStart, limits } = entitlements;
  const runs = RUN_LIMIT_OF_KIND[reviewKind];
  const runLimit = limits[runs.limit];
  if (
    options.runQuotas !== false &&
    runLimit !== null &&
    (await usage.runsSince(reviewKind, periodStart)) >= runLimit
  )
    return exhausted(runs.detail, periodStart);

  const { keyMode } = entitlements;
  const cost = COST_LIMIT_OF_KEY_MODE[keyMode];
  const costLimit = limits[cost.limit];
  if (
    costLimit !== null &&
    (await usage.costSince(keyMode, periodStart)) >= costLimit
  )
    return exhausted(cost.detail, periodStart);

  return { allow: true };
}
