// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { PlanKind, PlanTerms } from "../admin/ui/plans-view.ts";
import { PRICE_MAX_MINOR } from "../admin/ui/plan-money.ts";
import {
  validateNewPlan,
  validatePlanMetadata,
  validatePlanTerms,
} from "./plan-rules.ts";

const NOW = new Date("2026-10-18T10:00:00.000Z");
const CONTEXT = { planName: "Team", now: NOW };

// Made-up numbers throughout: no amount or limit of a real plan lives in the repository.
const LIMITS = {
  diffRunsPerPeriod: 40,
  dynamicRunsPerPeriod: 8,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

function managed(overrides: Record<string, unknown> = {}) {
  return {
    keyMode: "managed",
    limits: LIMITS,
    modelAccess: { catalogEntries: ["mce_one", "mce_two"] },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: null,
    ...overrides,
  };
}

function own(overrides: Record<string, unknown> = {}) {
  return {
    keyMode: "own",
    limits: {
      ...LIMITS,
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
    },
    modelAccess: null,
    monthlyAmountMinor: 1000,
    yearlyAmountMinor: null,
    ...overrides,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    name: "Team",
    description: "For small teams.",
    sort: 20,
    offered: true,
    popular: false,
    contactTarget: null,
    ...overrides,
  };
}

function refusedCode(
  result: { ok: true } | { ok: false; code: string; field?: string },
) {
  return result.ok ? "ok" : result.code;
}

describe("the terms of a plan version", () => {
  // #438-T01
  it("accepts a managed paid version with limits and an explicit model access", () => {
    const result = validatePlanTerms("paid", managed(), CONTEXT);

    expect(result).toEqual({
      ok: true,
      value: {
        keyMode: "managed",
        limits: LIMITS,
        modelAccess: { catalogEntries: ["mce_one", "mce_two"] },
        monthlyAmountMinor: 1234,
        yearlyAmountMinor: null,
      },
    });
  });

  // #438-T14
  it("accepts an own paid version with unlimited run limits and no model access", () => {
    const result = validatePlanTerms("paid", own(), CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.keyMode).toBe("own");
    expect(result.value.modelAccess).toBeNull();
    expect(result.value.limits.diffRunsPerPeriod).toBeNull();
    expect(result.value.limits.dynamicRunsPerPeriod).toBeNull();
  });

  // #438-T15
  it("accepts an own version with run limits and the own key cost limit", () => {
    const result = validatePlanTerms(
      "paid",
      own({
        limits: {
          diffRunsPerPeriod: 75,
          dynamicRunsPerPeriod: 11,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: 3_000_000,
        },
      }),
      CONTEXT,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        limits: {
          diffRunsPerPeriod: 75,
          dynamicRunsPerPeriod: 11,
          ownKeyCostLimitMicroUsd: 3_000_000,
        },
      },
    });
  });

  // #438-T07
  it("refuses limits the entitlements refuse", () => {
    expect(
      validatePlanTerms(
        "paid",
        managed({ limits: { ...LIMITS, diffRunsPerPeriod: -1 } }),
        CONTEXT,
      ),
    ).toEqual({ ok: false, code: "limit_invalid", field: "diffRunsPerPeriod" });
    expect(
      validatePlanTerms(
        "paid",
        managed({ limits: { ...LIMITS, dynamicRunsPerPeriod: 1.5 } }),
        CONTEXT,
      ),
    ).toEqual({
      ok: false,
      code: "limit_invalid",
      field: "dynamicRunsPerPeriod",
    });
    expect(validatePlanTerms("paid", managed({ limits: 5 }), CONTEXT)).toEqual({
      ok: false,
      code: "limits_invalid",
    });
    expect(
      validatePlanTerms(
        "paid",
        managed({ limits: { diffRunsPerPeriod: 1 } }),
        CONTEXT,
      ),
    ).toMatchObject({ ok: false, code: "limits_invalid" });
  });

  // #438-T07
  it("refuses a model access that is not a list of catalog entry ids", () => {
    for (const modelAccess of [
      { catalogEntries: ["not-an-entry-id"] },
      { catalogEntries: "mce_one" },
      { catalogEntries: ["mce_one", "mce_one"] },
      { catalogEntries: [], extra: true },
    ])
      expect(
        validatePlanTerms("paid", managed({ modelAccess }), CONTEXT),
      ).toMatchObject({ ok: false, code: "catalog_entry_invalid" });
  });

  // #438-T01
  it("refuses a managed version that does not state its model access", () => {
    for (const modelAccess of [null, undefined])
      expect(
        validatePlanTerms("paid", managed({ modelAccess }), CONTEXT),
      ).toEqual({
        ok: false,
        code: "catalog_entry_invalid",
        field: "modelAccess",
      });
  });

  // #438-T01
  it("accepts an explicit null list (every released entry) and an empty list (none)", () => {
    expect(
      refusedCode(
        validatePlanTerms(
          "paid",
          managed({ modelAccess: { catalogEntries: null } }),
          CONTEXT,
        ),
      ),
    ).toBe("ok");
    expect(
      refusedCode(
        validatePlanTerms(
          "paid",
          managed({ modelAccess: { catalogEntries: [] } }),
          CONTEXT,
        ),
      ),
    ).toBe("ok");
  });

  // #438-T16
  it("refuses an own version with a model access", () => {
    expect(
      validatePlanTerms(
        "paid",
        own({ modelAccess: { catalogEntries: null } }),
        CONTEXT,
      ),
    ).toEqual({
      ok: false,
      code: "model_access_requires_managed_plan",
      field: "modelAccess",
    });
    expect(
      validatePlanTerms(
        "paid",
        own({ modelAccess: { catalogEntries: ["mce_one"] } }),
        CONTEXT,
      ),
    ).toMatchObject({
      ok: false,
      code: "model_access_requires_managed_plan",
    });
  });

  // #438-T16
  it("refuses an own version with the operator cost limit", () => {
    expect(
      validatePlanTerms(
        "paid",
        own({
          limits: {
            ...LIMITS,
            diffRunsPerPeriod: null,
            managedCostLimitMicroUsd: 0,
          },
        }),
        CONTEXT,
      ),
    ).toEqual({
      ok: false,
      code: "cost_limit_requires_managed_key",
      field: "managedCostLimitMicroUsd",
    });
  });

  // #438-T17
  it("refuses a key mode other than the two", () => {
    for (const keyMode of ["shared", "", null, 3, undefined])
      expect(
        validatePlanTerms("paid", managed({ keyMode }), CONTEXT),
      ).toMatchObject({ ok: false, code: "plan_key_mode_invalid" });
  });

  // #438-T17
  it("refuses the Free plan any key mode but managed", () => {
    const free = validatePlanTerms(
      "free",
      managed({ keyMode: "own", modelAccess: null, monthlyAmountMinor: null }),
      CONTEXT,
    );

    expect(free).toEqual({
      ok: false,
      code: "free_plan_key_mode_fixed",
      field: "keyMode",
    });
  });

  // #438-T17
  it("refuses an own version on a plan that is not paid", () => {
    expect(
      validatePlanTerms("contact", own({ monthlyAmountMinor: null }), CONTEXT),
    ).toEqual({
      ok: false,
      code: "own_plan_requires_paid_plan",
      field: "keyMode",
    });
  });

  // #438-T09
  it("gives an Enterprise plan no versions", () => {
    expect(
      validatePlanTerms(
        "contact",
        managed({ monthlyAmountMinor: null }),
        CONTEXT,
      ),
    ).toMatchObject({ ok: false, code: "contact_plan_has_no_versions" });
  });

  describe("the prices", () => {
    // #438-T24
    it("needs a monthly price on a paid version", () => {
      for (const monthlyAmountMinor of [null, undefined])
        expect(
          validatePlanTerms("paid", managed({ monthlyAmountMinor }), CONTEXT),
        ).toEqual({
          ok: false,
          code: "plan_price_invalid",
          field: "monthlyAmountMinor",
        });
    });

    // #438-T24
    it.each([
      0,
      -1,
      9.99,
      "9.99",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 60,
    ])("refuses %j as a monthly price", (monthlyAmountMinor) => {
      expect(
        validatePlanTerms("paid", managed({ monthlyAmountMinor }), CONTEXT),
      ).toEqual({
        ok: false,
        code: "plan_price_invalid",
        field: "monthlyAmountMinor",
      });
    });

    // #438-T24
    it.each([0, -5, 1.5, "100", Number.NaN])(
      "refuses %j as a yearly price",
      (yearlyAmountMinor) => {
        expect(
          validatePlanTerms("paid", managed({ yearlyAmountMinor }), CONTEXT),
        ).toEqual({
          ok: false,
          code: "plan_price_invalid",
          field: "yearlyAmountMinor",
        });
      },
    );

    // #438-N5
    it("takes a price up to the upper bound, which is 1,000,000 USD in cents and fits the integer column", () => {
      expect(PRICE_MAX_MINOR).toBe(100_000_000);
      expect(PRICE_MAX_MINOR).toBeLessThan(2 ** 31);
      expect(
        validatePlanTerms(
          "paid",
          managed({
            monthlyAmountMinor: PRICE_MAX_MINOR,
            yearlyAmountMinor: PRICE_MAX_MINOR,
          }),
          CONTEXT,
        ),
      ).toMatchObject({
        ok: true,
        value: {
          monthlyAmountMinor: PRICE_MAX_MINOR,
          yearlyAmountMinor: PRICE_MAX_MINOR,
        },
      });
      expect(
        validatePlanTerms(
          "paid",
          managed({ monthlyAmountMinor: 1, yearlyAmountMinor: 1 }),
          CONTEXT,
        ),
      ).toMatchObject({ ok: true });
    });

    // #438-N5
    it.each([PRICE_MAX_MINOR + 1, 2 ** 31 - 1, 2 ** 31, 2 ** 40])(
      "refuses %j as a monthly price: above the bound, or what an integer column cannot hold",
      (monthlyAmountMinor) => {
        expect(
          validatePlanTerms("paid", managed({ monthlyAmountMinor }), CONTEXT),
        ).toEqual({
          ok: false,
          code: "plan_price_invalid",
          field: "monthlyAmountMinor",
        });
      },
    );

    // #438-N5
    it.each([PRICE_MAX_MINOR + 1, 2 ** 31, 2 ** 40])(
      "refuses %j as a yearly price",
      (yearlyAmountMinor) => {
        expect(
          validatePlanTerms("paid", managed({ yearlyAmountMinor }), CONTEXT),
        ).toEqual({
          ok: false,
          code: "plan_price_invalid",
          field: "yearlyAmountMinor",
        });
      },
    );

    // #438-T21
    it("keeps both prices as the integers given", () => {
      expect(
        validatePlanTerms(
          "paid",
          managed({ monthlyAmountMinor: 999, yearlyAmountMinor: 9900 }),
          CONTEXT,
        ),
      ).toMatchObject({
        ok: true,
        value: { monthlyAmountMinor: 999, yearlyAmountMinor: 9900 },
      });
    });

    // #438-T22
    it("reads a missing or null yearly price as no yearly option", () => {
      for (const yearlyAmountMinor of [null, undefined])
        expect(
          validatePlanTerms("paid", managed({ yearlyAmountMinor }), CONTEXT),
        ).toMatchObject({ ok: true, value: { yearlyAmountMinor: null } });
    });

    // #438-T24
    it.each(["monthlyAmountMinor", "yearlyAmountMinor"])(
      "refuses %s on the Free plan",
      (field) => {
        expect(
          validatePlanTerms(
            "free",
            managed({
              modelAccess: { catalogEntries: [] },
              monthlyAmountMinor: null,
              yearlyAmountMinor: null,
              [field]: 500,
            }),
            CONTEXT,
          ),
        ).toEqual({ ok: false, code: "plan_price_not_allowed", field });
      },
    );

    // #438-T24
    it("accepts the Free plan with no price at all", () => {
      expect(
        validatePlanTerms(
          "free",
          managed({
            modelAccess: { catalogEntries: [] },
            monthlyAmountMinor: null,
            yearlyAmountMinor: null,
          }),
          { planName: "Free", now: NOW },
        ),
      ).toMatchObject({ ok: true });
    });
  });
});

describe("the fields edited in place", () => {
  // #438-T03
  it("accepts a full set of display fields", () => {
    expect(validatePlanMetadata("paid", metadata())).toEqual({
      ok: true,
      value: metadata(),
    });
  });

  // #438-T07
  it("refuses a name, a description and a sort that cannot be stored", () => {
    expect(validatePlanMetadata("paid", metadata({ name: " " }))).toMatchObject(
      {
        ok: false,
        code: "plan_name_invalid",
      },
    );
    expect(
      validatePlanMetadata("paid", metadata({ name: "x".repeat(65) })),
    ).toMatchObject({ ok: false, code: "plan_name_invalid" });
    expect(
      validatePlanMetadata("paid", metadata({ description: "x".repeat(401) })),
    ).toMatchObject({ ok: false, code: "plan_description_invalid" });
    for (const sort of [1.5, "3", -1, 100_001, null])
      expect(validatePlanMetadata("paid", metadata({ sort }))).toMatchObject({
        ok: false,
        code: "plan_sort_invalid",
      });
  });

  // #438-T07
  it("refuses a field it does not know and a flag that is not a boolean", () => {
    expect(
      validatePlanMetadata("paid", metadata({ monthlyAmountMinor: 100 })),
    ).toMatchObject({ ok: false, code: "plan_input_invalid" });
    expect(
      validatePlanMetadata("paid", metadata({ offered: "yes" })),
    ).toMatchObject({
      ok: false,
      code: "plan_input_invalid",
      field: "offered",
    });
  });

  // #438-T29
  it.each<PlanKind>(["free", "contact"])(
    "refuses the Popular flag on a %s plan",
    (kind) => {
      const result = validatePlanMetadata(
        kind,
        metadata({
          popular: true,
          contactTarget:
            kind === "contact" ? "https://example.test/talk" : null,
        }),
      );

      expect(result).toEqual({
        ok: false,
        code: "popular_requires_paid_plan",
        field: "popular",
      });
    },
  );

  // #438-T29
  it("accepts the Popular flag on a paid plan", () => {
    expect(
      validatePlanMetadata("paid", metadata({ popular: true })),
    ).toMatchObject({ ok: true, value: { popular: true } });
  });

  describe("the contact target", () => {
    const enterprise = (overrides: Record<string, unknown>) =>
      metadata({ name: "Enterprise", ...overrides });

    // #438-T30
    it.each(["https://example.test/contact-us", "mailto:sales@example.test"])(
      "accepts %s",
      (contactTarget) => {
        expect(
          validatePlanMetadata("contact", enterprise({ contactTarget })),
        ).toMatchObject({ ok: true, value: { contactTarget } });
      },
    );

    // #438-T07
    it.each([
      "http://example.test/talk",
      "javascript:alert(1)",
      "ftp://example.test",
      "data:text/html,hi",
      "example.test/talk",
      "mailto:",
      "mailto:not an address",
      "mailto:a@b.test?subject=x",
      "https://user:pw@example.test/",
      "https://",
      "",
      "//example.test",
      "https://example.test/\nx",
    ])("refuses %j", (contactTarget) => {
      expect(
        validatePlanMetadata("contact", enterprise({ contactTarget })),
      ).toEqual({
        ok: false,
        code: "contact_target_invalid",
        field: "contactTarget",
      });
    });

    // #438-T30
    it("refuses to offer a contact plan without a target", () => {
      expect(
        validatePlanMetadata(
          "contact",
          enterprise({ offered: true, contactTarget: null }),
        ),
      ).toEqual({
        ok: false,
        code: "contact_target_required",
        field: "contactTarget",
      });
    });

    // #438-T30
    it("lets a contact plan that is not offered wait without a target", () => {
      expect(
        validatePlanMetadata(
          "contact",
          enterprise({ offered: false, contactTarget: null }),
        ),
      ).toMatchObject({ ok: true });
    });

    // #438-T07
    it.each<PlanKind>(["free", "paid"])(
      "belongs to a contact plan only, not to a %s plan",
      (kind) => {
        expect(
          validatePlanMetadata(
            kind,
            metadata({ contactTarget: "https://example.test/talk" }),
          ),
        ).toEqual({
          ok: false,
          code: "contact_target_not_allowed",
          field: "contactTarget",
        });
      },
    );
  });
});

describe("a new plan", () => {
  function newPlan(overrides: Record<string, unknown> = {}) {
    return {
      planKey: "team",
      kind: "paid",
      ...metadata(),
      terms: managed(),
      ...overrides,
    };
  }

  // #438-T01
  it("takes its key, kind, display fields and first terms", () => {
    const result = validateNewPlan(newPlan(), NOW);

    expect(result).toMatchObject({
      ok: true,
      value: {
        planKey: "team",
        kind: "paid",
        metadata: metadata(),
        terms: managed() satisfies Record<string, unknown> as PlanTerms,
      },
    });
  });

  // #438-T09
  it("takes an Enterprise plan with no terms", () => {
    const result = validateNewPlan(
      newPlan({
        planKey: "enterprise",
        kind: "contact",
        name: "Enterprise",
        contactTarget: "mailto:sales@example.test",
        terms: undefined,
      }),
      NOW,
    );

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "contact", terms: null },
    });
  });

  // #438-T09
  it("refuses terms for an Enterprise plan and none for a paid plan", () => {
    expect(
      validateNewPlan(
        newPlan({ kind: "contact", contactTarget: "mailto:a@b.test" }),
        NOW,
      ),
    ).toMatchObject({ ok: false, code: "contact_plan_has_no_versions" });
    expect(validateNewPlan(newPlan({ terms: undefined }), NOW)).toMatchObject({
      ok: false,
      code: "plan_input_invalid",
      field: "terms",
    });
  });

  // #438-T17
  it("refuses an own plan of kind free or contact", () => {
    for (const kind of ["free", "contact"])
      expect(
        validateNewPlan(
          newPlan({
            kind,
            contactTarget: kind === "contact" ? "mailto:a@b.test" : null,
            terms: own({ monthlyAmountMinor: null }),
          }),
          NOW,
        ),
      ).toMatchObject({ ok: false, code: "own_plan_requires_paid_plan" });
  });

  // #438-T08
  it("does not create a second Free plan", () => {
    expect(
      validateNewPlan(
        newPlan({
          kind: "free",
          terms: managed({ monthlyAmountMinor: null }),
        }),
        NOW,
      ),
    ).toEqual({ ok: false, code: "plan_kind_invalid", field: "kind" });
  });

  it.each(["", "Team", "1team", "a", "te am", "x".repeat(33), "te_am", 5])(
    "refuses the plan key %j",
    (planKey) => {
      expect(validateNewPlan(newPlan({ planKey }), NOW)).toEqual({
        ok: false,
        code: "plan_key_invalid",
        field: "planKey",
      });
    },
  );
});
