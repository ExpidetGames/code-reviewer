// SPDX-License-Identifier: LicenseRef-Proprietary

// The cost limit of a job as the claim sends it (#666, #689). Two values bound a review: the customer's own limit (the project's
// setting over the workspace default) and the operator's maximum per review (the admin portal). The runner enforces the
// smaller. The job is a closed object, so what goes into it depends on what the caller named:
//
// - `operator_cost_limit` (and `cost_limit`): the job carries both, `llm.maxCostUsd` (the customer's) and
//   `llm.operatorMaxCostUsd`, and the runner takes the smaller and names whose limit it was in `stoppedEarly`.
// - `cost_limit` alone (a runner of the release before): `llm.maxCostUsd` carries the smaller of the two. That runner holds a
//   Dynamic run to the smaller of that and its own `RUNNER_DYNAMIC_MAX_COST_USD`, so the maximum can only narrow there.
// - neither: nothing is sent and the job is the job of before. A refused review is worse than a limit that is not kept for the
//   minutes a release leaves an older runner behind, so the claim does not refuse it.
//
// Pure.
import type { ClaimFeature } from "./contract.ts";

export type JobCostLimitFields = {
  maxCostUsd?: number;
  operatorMaxCostUsd?: number;
};

export type JobCostLimit = {
  fields: JobCostLimitFields;
  /** `both`: the runner knows the two values. `folded`: one value carries the smaller. `none`: the caller enforces neither. */
  enforced: "both" | "folded" | "none";
};

const usd = (cents: number): number => cents / 100;

export function jobCostLimit(input: {
  /** The customer's limit in whole cents; absent when they set none. */
  customerCents?: number | undefined;
  /** The operator's maximum in whole cents. */
  operatorCents: number;
  features: readonly ClaimFeature[];
}): JobCostLimit {
  const { customerCents, operatorCents, features } = input;
  const knowsCustomer = features.includes("cost_limit");
  if (features.includes("operator_cost_limit"))
    return {
      fields: {
        ...(knowsCustomer && customerCents !== undefined
          ? { maxCostUsd: usd(customerCents) }
          : {}),
        operatorMaxCostUsd: usd(operatorCents),
      },
      enforced: "both",
    };
  if (knowsCustomer)
    return {
      fields: {
        maxCostUsd: usd(
          Math.min(customerCents ?? operatorCents, operatorCents),
        ),
      },
      enforced: "folded",
    };
  return { fields: {}, enforced: "none" };
}
