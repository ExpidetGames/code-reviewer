// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  describeLimit,
  describeModelAccess,
  describePrice,
  emptyTermsForm,
  termsFormFrom,
  termsFromForm,
  type TermsForm,
} from "./plans-format.ts";
import type { CatalogChoice, PlanTerms } from "./plans-view.ts";

// Made-up numbers throughout.
const MANAGED: PlanTerms = {
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 40,
    dynamicRunsPerPeriod: 8,
    managedCostLimitMicroUsd: 2_500_000,
    ownKeyCostLimitMicroUsd: null,
  },
  modelAccess: { catalogEntries: ["mce_one"] },
  monthlyAmountMinor: 1234,
  yearlyAmountMinor: 12_340,
};

describe("the terms form", () => {
  // #438-T14
  it("starts an own plan with unlimited run limits and no model access", () => {
    const form: TermsForm = { ...emptyTermsForm("paid"), keyMode: "own" };

    const result = termsFromForm("paid", { ...form, monthly: "10" });

    expect(result).toEqual({
      ok: true,
      terms: {
        keyMode: "own",
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        modelAccess: null,
        monthlyAmountMinor: 1000,
        yearlyAmountMinor: null,
      },
    });
  });

  // #438-T15
  it("reads run limits and the own key cost limit as typed", () => {
    const result = termsFromForm("paid", {
      ...emptyTermsForm("paid"),
      keyMode: "own",
      diffRuns: "75",
      dynamicRuns: "11",
      ownKeyCostUsd: "3",
      monthly: "10",
    });

    expect(result).toMatchObject({
      ok: true,
      terms: {
        limits: {
          diffRunsPerPeriod: 75,
          dynamicRunsPerPeriod: 11,
          ownKeyCostLimitMicroUsd: 3_000_000,
        },
      },
    });
  });

  // #438-T14
  it("drops the model access and the operator cost limit of a form switched to the own key", () => {
    const form: TermsForm = {
      ...termsFormFrom(MANAGED),
      keyMode: "own",
    };

    const result = termsFromForm("paid", form);

    expect(result).toMatchObject({
      ok: true,
      terms: {
        keyMode: "own",
        modelAccess: null,
        limits: { managedCostLimitMicroUsd: null },
      },
    });
  });

  // #438-T21
  it("reads both prices as minor units", () => {
    const result = termsFromForm("paid", {
      ...termsFormFrom(MANAGED),
      monthly: "9.99",
      yearly: "99",
    });

    expect(result).toMatchObject({
      ok: true,
      terms: { monthlyAmountMinor: 999, yearlyAmountMinor: 9900 },
    });
  });

  // #438-T22
  it("reads an empty yearly field as no yearly option", () => {
    const result = termsFromForm("paid", {
      ...termsFormFrom(MANAGED),
      yearly: "",
    });

    expect(result).toMatchObject({
      ok: true,
      terms: { yearlyAmountMinor: null },
    });
  });

  // #438-T24
  it("refuses a missing monthly price, a zero price and a price with three decimals", () => {
    const base = termsFormFrom(MANAGED);

    expect(termsFromForm("paid", { ...base, monthly: "" })).toEqual({
      ok: false,
      issues: [{ field: "monthlyAmountMinor", code: "plan_price_invalid" }],
    });
    expect(termsFromForm("paid", { ...base, monthly: "0" })).toMatchObject({
      ok: false,
      issues: [{ field: "monthlyAmountMinor", code: "plan_price_invalid" }],
    });
    expect(termsFromForm("paid", { ...base, yearly: "9.999" })).toEqual({
      ok: false,
      issues: [{ field: "yearlyAmountMinor", code: "plan_price_invalid" }],
    });
  });

  it("refuses a limit that is not a whole number", () => {
    expect(
      termsFromForm("paid", { ...termsFormFrom(MANAGED), diffRuns: "ten" }),
    ).toEqual({
      ok: false,
      issues: [{ field: "diffRunsPerPeriod", code: "limit_invalid" }],
    });
    expect(
      termsFromForm("paid", { ...termsFormFrom(MANAGED), dynamicRuns: "1.5" }),
    ).toMatchObject({ ok: false });
    expect(
      termsFromForm("paid", { ...termsFormFrom(MANAGED), managedCostUsd: "x" }),
    ).toEqual({
      ok: false,
      issues: [{ field: "managedCostLimitMicroUsd", code: "limit_invalid" }],
    });
  });

  // #438-T05
  it("gives the Free plan no price and always the managed key mode", () => {
    const result = termsFromForm("free", {
      ...emptyTermsForm("free"),
      keyMode: "own",
      monthly: "5",
      diffRuns: "10",
      dynamicRuns: "2",
      accessAll: false,
      entries: [],
    });

    expect(result).toMatchObject({
      ok: true,
      terms: {
        keyMode: "managed",
        monthlyAmountMinor: null,
        yearlyAmountMinor: null,
        modelAccess: { catalogEntries: [] },
        limits: { diffRunsPerPeriod: 10, dynamicRunsPerPeriod: 2 },
      },
    });
  });

  it("states the model access of a managed plan: every released entry or the chosen ones", () => {
    const all = termsFromForm("paid", {
      ...termsFormFrom(MANAGED),
      accessAll: true,
    });
    const chosen = termsFromForm("paid", {
      ...termsFormFrom(MANAGED),
      accessAll: false,
      entries: ["mce_a", "mce_b"],
    });

    expect(all).toMatchObject({
      ok: true,
      terms: { modelAccess: { catalogEntries: null } },
    });
    expect(chosen).toMatchObject({
      ok: true,
      terms: { modelAccess: { catalogEntries: ["mce_a", "mce_b"] } },
    });
  });

  it("round-trips a version through the form", () => {
    expect(termsFromForm("paid", termsFormFrom(MANAGED))).toEqual({
      ok: true,
      terms: MANAGED,
    });
  });
});

describe("the words for a version", () => {
  const catalog: CatalogChoice[] = [
    {
      id: "mce_one",
      name: "Fast",
      provider: "p",
      modelId: "m/1",
      status: "released",
    },
  ];

  it("writes a limit, an amount and a model access", () => {
    expect(describeLimit(null)).toBe("Unlimited");
    expect(describeLimit(12)).toBe("12");
    expect(describePrice(1234)).toBe("$12.34");
    expect(describePrice(1000)).toBe("$10.00");
    expect(describePrice(null)).toBe("none");
    expect(describeModelAccess({ catalogEntries: null }, catalog)).toBe(
      "Every released entry",
    );
    expect(describeModelAccess({ catalogEntries: [] }, catalog)).toBe("None");
    expect(
      describeModelAccess({ catalogEntries: ["mce_one", "mce_gone"] }, catalog),
    ).toBe("Fast, 1 entry that no longer exists");
    expect(describeModelAccess(null, catalog)).toBe(
      "Any model with the workspace's own keys",
    );
  });
});
