// SPDX-License-Identifier: Apache-2.0

// Whether a claimed job may run, given what an operator allows the workspace (src/workspaces/entitlements.ts)
// and what it used in the period (src/usage/README.md, "Limits"). Pure: the usage is read through a small
// interface, and only as far as the answer needs it, so a workspace without limits reads nothing. The queue's claim
// (src/db/repositories/claim-admission.ts) feeds it inside the transaction that reserves the usage record.
import type { JobErrorCode } from "../jobs/job-types.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import {
  ENTITLEMENTS_INVALID_CODE,
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
] as const;
export type QuotaDetail = (typeof QUOTA_DETAILS)[number];

export type Admission =
  | { allow: true }
  | { allow: false; errorCode: EntitlementRefusalCode; detail?: QuotaDetail };

/** What the workspace used since the start of its period; each read is one indexed query in the database. */
export type AdmissionUsage = {
  /** Records of the kind that count (`reserved` and `settled`) reserved at or after `since`. */
  runsSince(kind: ProjectReviewKind, since: string): Promise<number>;
  /** The known cost of the settled managed records reserved at or after `since`, micro-USD. */
  managedCostSince(since: string): Promise<number>;
};

const RUN_LIMIT_OF_KIND = {
  diff: { limit: "diffRunsPerPeriod", detail: "diff_runs" },
  dynamic: { limit: "dynamicRunsPerPeriod", detail: "dynamic_runs" },
} as const satisfies Record<
  ProjectReviewKind,
  { limit: string; detail: QuotaDetail }
>;

function exhausted(detail: QuotaDetail): Admission {
  return { allow: false, errorCode: "quota_exhausted", detail };
}

/**
 * The decision, in this order, the first refusal wins:
 *
 * 1. entitlements that cannot be read: refused (`entitlements_invalid`), never read as unlimited;
 * 2. a suspended workspace: `workspace_suspended`;
 * 3. the run limit of the job's kind: the runs of that kind in the period at or above it (0 allows none) refuse;
 * 4. the cost limit, for a workspace that runs on the operator's key (`keyMode` `managed`): the settled managed
 *    cost of the period at or above it refuses. A run with an unknown cost adds nothing to the sum (it still
 *    counts in 3). The limit is a soft cap: runs in flight are not in the sum.
 *
 * A limit of `null` is not read at all.
 */
export async function decideAdmission(
  entitlements: ResolvedEntitlements,
  reviewKind: ProjectReviewKind,
  usage: AdmissionUsage,
): Promise<Admission> {
  if (entitlements.kind === "unlimited") return { allow: true };
  if (entitlements.kind === "invalid")
    return { allow: false, errorCode: entitlements.code };
  if (entitlements.suspended)
    return { allow: false, errorCode: "workspace_suspended" };

  const { periodStart, limits } = entitlements;
  const runs = RUN_LIMIT_OF_KIND[reviewKind];
  const runLimit = limits[runs.limit];
  if (
    runLimit !== null &&
    (await usage.runsSince(reviewKind, periodStart)) >= runLimit
  )
    return exhausted(runs.detail);

  const costLimit = limits.managedCostLimitMicroUsd;
  if (
    costLimit !== null &&
    entitlements.keyMode === "managed" &&
    (await usage.managedCostSince(periodStart)) >= costLimit
  )
    return exhausted("managed_cost");

  return { allow: true };
}
