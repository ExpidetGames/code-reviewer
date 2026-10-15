// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { JsonValue } from "../integrations/types.ts";
import {
  costUsdToMicroUsd,
  keyModeOfAccessSource,
  settlementOfOutcome,
} from "./usage-records.ts";

const USAGE = {
  model: "vendor/model",
  promptTokens: 12000,
  completionTokens: 900,
  totalTokens: 12900,
  aiCalls: 2,
  fallbackUsed: false,
  costUsd: 0.0123456,
};

describe("the measured cost of a run in micro-USD", () => {
  // #272-T02
  it.each([
    [0.0123456, 12346],
    [0, 0],
    [0.04, 40000],
    [1, 1_000_000],
    [0.000001, 1],
    [0.0000004, 0],
  ])("turns %s USD into %s micro-USD", (costUsd, expected) => {
    expect(costUsdToMicroUsd(costUsd)).toBe(expected);
  });

  // #272-T02
  it("rounds half up, also where the binary value sits just below the half", () => {
    expect(costUsdToMicroUsd(0.0000005)).toBe(1);
    expect(costUsdToMicroUsd(0.0000015)).toBe(2);
    expect(costUsdToMicroUsd(1.0000005)).toBe(1_000_001);
  });

  it("is unknown for a cost no record can hold", () => {
    expect(costUsdToMicroUsd(Number.MAX_VALUE)).toBeNull();
    expect(costUsdToMicroUsd(2147.483648)).toBeNull();
    expect(costUsdToMicroUsd(2147.483647)).toBe(2_147_483_647);
    expect(costUsdToMicroUsd(Number.NaN)).toBeNull();
    expect(costUsdToMicroUsd(-1)).toBeNull();
  });
});

describe("how a completed job settles its usage record", () => {
  // #272-T02
  it("settles a reported usage with its cost and tokens", () => {
    expect(
      settlementOfOutcome({ ok: true, result: { ok: true, usage: USAGE } }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: 12346,
      promptTokens: 12000,
      completionTokens: 900,
    });
  });

  // #272-T03
  it("settles a reported usage without a cost with an unknown cost, not as void", () => {
    expect(
      settlementOfOutcome({
        ok: true,
        result: { ok: true, usage: { ...USAGE, costUsd: null } },
      }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: null,
      promptTokens: 12000,
      completionTokens: 900,
    });
  });

  it("settles a run that succeeded without a usage with everything unknown", () => {
    const results: JsonValue[] = [
      { ok: true, usage: null },
      { ok: true },
      null,
    ];
    for (const result of results)
      expect(settlementOfOutcome({ ok: true, result })).toStrictEqual({
        state: "settled",
        costMicroUsd: null,
        promptTokens: null,
        completionTokens: null,
      });
  });

  // #272-T04
  it("voids a failed job that reported no usage", () => {
    const results: JsonValue[] = [
      { ok: false, usage: null },
      { ok: false },
      null,
    ];
    for (const result of results)
      expect(
        settlementOfOutcome({
          ok: false,
          errorCode: "checkout_failed",
          result,
        }),
      ).toStrictEqual({ state: "void" });
    expect(
      settlementOfOutcome({ ok: false, errorCode: "checkout_failed" }),
    ).toStrictEqual({ state: "void" });
  });

  // #273-T05
  it("settles a failed job that reported the usage of its calls, with an unknown cost kept unknown", () => {
    const failed = (usage: JsonValue): JsonValue => ({ ok: false, usage });

    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "dynamic_budget_exceeded",
        result: failed({ ...USAGE, costUsd: 0.0035 }),
      }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: 3500,
      promptTokens: 12000,
      completionTokens: 900,
    });
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "dynamic_accounting_failed",
        result: failed({ ...USAGE, costUsd: null }),
      }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: null,
      promptTokens: 12000,
      completionTokens: 900,
    });
  });

  // #273-T03: a runner of an earlier release reports the usage of a failed command that never reached
  // the model as zero calls; that is no run that used the model.
  it("voids a failed job whose usage shows no model call, but not a run that succeeded", () => {
    const noCall = {
      ...USAGE,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      aiCalls: 0,
      costUsd: null,
    };

    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "command_failed",
        result: { ok: false, usage: noCall },
      }),
    ).toStrictEqual({ state: "void" });
    expect(
      settlementOfOutcome({ ok: true, result: { ok: true, usage: noCall } }),
    ).toMatchObject({ state: "settled", promptTokens: 0 });
    // A call that was made but answered nothing is a call.
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "dynamic_engine_unavailable",
        result: { ok: false, usage: { ...noCall, aiCalls: 1 } },
      }),
    ).toMatchObject({ state: "settled", costMicroUsd: null });
  });

  it("settles a failed job that did report a usage", () => {
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "review_failed",
        result: { ok: false, usage: USAGE },
      }),
    ).toMatchObject({ state: "settled", costMicroUsd: 12346 });
  });

  it.each([-1, 2_147_483_648, 1.5])(
    "does not trust a usage with %s tokens",
    (promptTokens) => {
      const damaged = { ...USAGE, promptTokens };
      expect(
        settlementOfOutcome({
          ok: false,
          errorCode: "review_failed",
          result: { ok: false, usage: damaged },
        }),
      ).toStrictEqual({ state: "void" });
    },
  );
});

describe("the key mode of a run", () => {
  // #272-T01
  it("is own for the workspace's key and managed for the operator's key", () => {
    expect(keyModeOfAccessSource("workspace")).toBe("own");
    expect(keyModeOfAccessSource("operator")).toBe("managed");
  });
});
