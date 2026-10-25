// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { jobCostLimit } from "./job-cost-limit.ts";

// #689: the cost limit of a job is the smaller of the customer's limit and the operator's maximum; how it travels depends on
// what the caller (a runner, or a Worker) named, because the job is a closed object.
describe("the cost limit of a job", () => {
  // #689-T11
  it("goes to a caller that reads the operator field as the two values, so the runner can tell whose limit stopped a run", () => {
    expect(
      jobCostLimit({
        customerCents: 50,
        operatorCents: 100,
        features: ["cost_limit", "operator_cost_limit"],
      }),
    ).toEqual({
      fields: { maxCostUsd: 0.5, operatorMaxCostUsd: 1 },
      enforced: "both",
    });
  });

  // #689-T11
  it("sends the operator's maximum alone when the customer set no limit", () => {
    expect(
      jobCostLimit({
        operatorCents: 250,
        features: ["cost_limit", "operator_cost_limit"],
      }),
    ).toEqual({ fields: { operatorMaxCostUsd: 2.5 }, enforced: "both" });
  });

  // #689-T11
  it("sends a limit above the maximum as it is: the runner takes the smaller, and the maximum wins", () => {
    expect(
      jobCostLimit({
        customerCents: 5000,
        operatorCents: 100,
        features: ["cost_limit", "operator_cost_limit"],
      }).fields,
    ).toEqual({ maxCostUsd: 50, operatorMaxCostUsd: 1 });
  });

  // #689-T12
  it("folds the two into maxCostUsd for a caller that reads only the project's limit, which can only narrow its own", () => {
    expect(
      jobCostLimit({
        customerCents: 50,
        operatorCents: 100,
        features: ["cost_limit"],
      }),
    ).toEqual({ fields: { maxCostUsd: 0.5 }, enforced: "folded" });
    expect(
      jobCostLimit({
        customerCents: 5000,
        operatorCents: 100,
        features: ["cost_limit"],
      }).fields,
    ).toEqual({ maxCostUsd: 1 });
    expect(
      jobCostLimit({ operatorCents: 100, features: ["cost_limit"] }).fields,
    ).toEqual({ maxCostUsd: 1 });
  });

  // #689-T12
  it("sends nothing to a caller that names neither feature: its job is the job of before", () => {
    expect(
      jobCostLimit({ customerCents: 50, operatorCents: 100, features: [] }),
    ).toEqual({ fields: {}, enforced: "none" });
    expect(
      jobCostLimit({
        operatorCents: 100,
        features: ["dynamic_capabilities", "supersede"],
      }),
    ).toEqual({ fields: {}, enforced: "none" });
  });

  // #689-T11
  it("keeps whole cents exact", () => {
    expect(
      jobCostLimit({
        customerCents: 7,
        operatorCents: 1,
        features: ["cost_limit", "operator_cost_limit"],
      }).fields,
    ).toEqual({ maxCostUsd: 0.07, operatorMaxCostUsd: 0.01 });
  });
});
