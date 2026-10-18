// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { PlanTerms } from "../admin/ui/plans-view.ts";
import { validateEntitlements } from "../workspaces/entitlements-validation.ts";
import { planEntitlements } from "./plan-entitlements.ts";

const PERIOD_START = "2026-10-01T00:00:00.000Z";
const NOW = new Date("2026-10-18T10:00:00.000Z");

const LIMITS = {
  diffRunsPerPeriod: 12,
  dynamicRunsPerPeriod: 3,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

function terms(overrides: Partial<PlanTerms> = {}): PlanTerms {
  return {
    keyMode: "managed",
    limits: LIMITS,
    modelAccess: { catalogEntries: ["mce_one"] },
    monthlyAmountMinor: 700,
    yearlyAmountMinor: null,
    ...overrides,
  };
}

describe("the entitlements a plan version writes", () => {
  // #438-MA1
  it("carry the model access of a managed version as it is", () => {
    const entitlements = planEntitlements({
      name: "Team",
      terms: terms(),
      periodStart: PERIOD_START,
    });

    expect(entitlements).toEqual({
      planLabel: "Team",
      keyMode: "managed",
      limits: LIMITS,
      periodStart: PERIOD_START,
      suspended: false,
      suspensionCode: null,
      modelAccess: { catalogEntries: ["mce_one"] },
    });
    expect(validateEntitlements(entitlements, NOW).ok).toBe(true);
  });

  // #438-MA2
  it("state an explicit model access for an own version too, and nothing reads it", () => {
    const entitlements = planEntitlements({
      name: "Own key",
      terms: terms({ keyMode: "own", modelAccess: null }),
      periodStart: PERIOD_START,
    });

    expect(entitlements.modelAccess).toEqual({ catalogEntries: null });
    expect(entitlements.keyMode).toBe("own");
  });

  // #438-MA2
  it.each([
    [
      "managed, every released entry",
      terms({ modelAccess: { catalogEntries: null } }),
    ],
    ["managed, none", terms({ modelAccess: { catalogEntries: [] } })],
    ["managed, a list", terms()],
    ["own", terms({ keyMode: "own", modelAccess: null })],
  ])("map a %s version to a defined model access", (_name, version) => {
    const entitlements = planEntitlements({
      name: "Plan",
      terms: version,
      periodStart: PERIOD_START,
    });

    expect(entitlements.modelAccess).toBeDefined();
    expect(entitlements.modelAccess).not.toBeNull();
    expect(
      entitlements.modelAccess.catalogEntries === null ||
        Array.isArray(entitlements.modelAccess.catalogEntries),
    ).toBe(true);
  });

  // #438-MA1
  it("throw when a managed version has no model access", () => {
    for (const modelAccess of [null, undefined])
      expect(() =>
        planEntitlements({
          name: "Team",
          terms: terms({ modelAccess } as Partial<PlanTerms>),
          periodStart: PERIOD_START,
        }),
      ).toThrow(/modelAccess/);
  });

  // #438-MA4
  it("replace the list on every write: a narrow list never survives into a wide plan", () => {
    const free = planEntitlements({
      name: "Free",
      terms: terms({ modelAccess: { catalogEntries: ["mce_small"] } }),
      periodStart: PERIOD_START,
    });
    const paid = planEntitlements({
      name: "Pro",
      terms: terms({ modelAccess: { catalogEntries: null } }),
      periodStart: PERIOD_START,
    });
    const back = planEntitlements({
      name: "Free",
      terms: terms({ modelAccess: { catalogEntries: [] } }),
      periodStart: PERIOD_START,
    });

    expect(free.modelAccess).toEqual({ catalogEntries: ["mce_small"] });
    expect(paid.modelAccess).toEqual({ catalogEntries: null });
    expect(back.modelAccess).toEqual({ catalogEntries: [] });
  });

  it("do not alias the list of the version", () => {
    const version = terms();
    const entitlements = planEntitlements({
      name: "Team",
      terms: version,
      periodStart: PERIOD_START,
    });
    entitlements.modelAccess.catalogEntries?.push("mce_other");

    expect(version.modelAccess?.catalogEntries).toEqual(["mce_one"]);
  });
});
