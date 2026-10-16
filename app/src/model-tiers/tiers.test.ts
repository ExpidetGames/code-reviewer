// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  checkManagedModelTiers,
  clampMaxTokens,
  configuredTiers,
  DEFAULT_MODEL_TIER,
  isModelTier,
  MODEL_TIERS,
  modelOfTier,
  readStoredTiers,
  tiersView,
} from "./tiers.ts";
import { TIER_NAME_PATTERN } from "../operator-api/contract.ts";

describe("the tiers", () => {
  // #280-T10
  it("are low, medium and high, and medium is the default", () => {
    expect([...MODEL_TIERS]).toEqual(["low", "medium", "high"]);
    expect(DEFAULT_MODEL_TIER).toBe("medium");
  });

  it("are names the usage record's tier name rule accepts", () => {
    for (const tier of MODEL_TIERS) expect(tier).toMatch(TIER_NAME_PATTERN);
  });

  it("recognises a tier name and nothing else", () => {
    expect(isModelTier("high")).toBe(true);
    expect(isModelTier("HIGH")).toBe(false);
    expect(isModelTier("ultra")).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
    expect(isModelTier(2)).toBe(false);
  });
});

describe("checking the operator's configuration of the tiers", () => {
  it("accepts a model for either kind of any tier, and an empty configuration", () => {
    expect(checkManagedModelTiers({ tiers: {} })).toEqual({
      ok: true,
      tiers: {},
    });
    expect(
      checkManagedModelTiers({
        tiers: {
          low: { diff: "vendor/low-diff" },
          high: { diff: "vendor/high-diff", dynamic: "vendor/high-dyn:free" },
        },
      }),
    ).toEqual({
      ok: true,
      tiers: {
        low: { diff: "vendor/low-diff" },
        high: { diff: "vendor/high-diff", dynamic: "vendor/high-dyn:free" },
      },
    });
  });

  it("reads null as not configured and keeps no empty tier", () => {
    expect(
      checkManagedModelTiers({
        tiers: { low: { diff: null, dynamic: null }, medium: { diff: "a/b" } },
      }),
    ).toEqual({ ok: true, tiers: { medium: { diff: "a/b" } } });
  });

  it("trims a model id, like the review settings do", () => {
    expect(
      checkManagedModelTiers({ tiers: { low: { diff: "  vendor/m  " } } }),
    ).toEqual({ ok: true, tiers: { low: { diff: "vendor/m" } } });
  });

  it("refuses a model id the review settings would refuse, naming the place and never the value", () => {
    const refused = checkManagedModelTiers({
      tiers: { high: { dynamic: "not a model id with spaces" } },
    });

    expect(refused).toEqual({
      ok: false,
      code: "model_id_invalid",
      field: "high.dynamic",
    });
    expect(JSON.stringify(refused)).not.toContain("spaces");
    expect(
      checkManagedModelTiers({ tiers: { low: { diff: "" } } }),
    ).toMatchObject({ ok: false, code: "model_id_invalid" });
    expect(
      checkManagedModelTiers({ tiers: { low: { diff: "x".repeat(201) } } }),
    ).toMatchObject({ ok: false, code: "model_id_invalid" });
  });

  it("refuses anything that is not the documented shape", () => {
    for (const body of [
      null,
      [],
      "tiers",
      {},
      { tiers: [] },
      { tiers: null },
      { tiers: {}, extra: 1 },
      { tiers: { ultra: { diff: "a/b" } } },
      { tiers: { low: "a/b" } },
      { tiers: { low: { other: "a/b" } } },
      { tiers: { low: { diff: 3 } } },
    ])
      expect(checkManagedModelTiers(body)).toMatchObject({
        ok: false,
        code: "request_invalid",
      });
  });

  it("does not echo an unknown name longer than the contract's field", () => {
    const refused = checkManagedModelTiers({
      tiers: { ["x".repeat(500)]: { diff: "a/b" } },
    });

    expect(refused).toMatchObject({ ok: false, code: "request_invalid" });
    expect(JSON.stringify(refused).length).toBeLessThan(200);
  });
});

describe("the stored configuration", () => {
  it("is read leniently: what this version would not accept is dropped, never thrown", () => {
    expect(readStoredTiers(undefined)).toEqual({});
    expect(readStoredTiers("nonsense")).toEqual({});
    expect(
      readStoredTiers({
        low: { diff: "a/b", dynamic: "bad id" },
        ultra: { diff: "a/b" },
        medium: "a/b",
        high: { dynamic: "c/d" },
      }),
    ).toEqual({ low: { diff: "a/b" }, high: { dynamic: "c/d" } });
  });

  // #280-T04
  it("answers the model of a tier for a review kind, or null", () => {
    const tiers = readStoredTiers({
      low: { diff: "a/low" },
      high: { diff: "a/high", dynamic: "a/high-dyn" },
    });

    expect(modelOfTier(tiers, "high", "diff")).toBe("a/high");
    expect(modelOfTier(tiers, "high", "dynamic")).toBe("a/high-dyn");
    // #280-T06: a tier without a model for the kind has none; another tier's model is not a stand-in.
    expect(modelOfTier(tiers, "low", "dynamic")).toBeNull();
    expect(modelOfTier(tiers, "medium", "diff")).toBeNull();
  });

  // #280-T01
  it("shows the whole shape to the operator, with a null for what is not configured", () => {
    expect(tiersView(readStoredTiers({ low: { diff: "a/low" } }))).toEqual({
      low: { diff: "a/low", dynamic: null },
      medium: { diff: null, dynamic: null },
      high: { diff: null, dynamic: null },
    });
  });

  // #280-T01
  it("shows nothing but whether a tier is configured to a portal reader", () => {
    const configured = configuredTiers(
      readStoredTiers({
        low: { diff: "secret/low" },
        high: { dynamic: "b/c" },
      }),
    );

    expect(configured).toEqual({
      low: { diff: true, dynamic: false },
      medium: { diff: false, dynamic: false },
      high: { diff: false, dynamic: true },
    });
    expect(JSON.stringify(configured)).not.toContain("secret");
  });
});

describe("the token budget of a managed job", () => {
  // #280-T09
  it("is clamped to the context window of the tier model when it is above", () => {
    expect(clampMaxTokens(500_000, 200_000)).toBe(200_000);
  });

  // #280-T09
  it("is left alone when it fits, or when the window is not known", () => {
    expect(clampMaxTokens(100_000, 200_000)).toBe(100_000);
    expect(clampMaxTokens(200_000, 200_000)).toBe(200_000);
    expect(clampMaxTokens(500_000, null)).toBe(500_000);
  });

  // #280-T09
  it("never clamps below what a runner accepts", () => {
    expect(clampMaxTokens(500_000, 800)).toBe(1000);
  });
});
