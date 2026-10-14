// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
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
    for (const result of [{ ok: true, usage: null }, { ok: true }, null])
      expect(settlementOfOutcome({ ok: true, result })).toStrictEqual({
        state: "settled",
        costMicroUsd: null,
        promptTokens: null,
        completionTokens: null,
      });
  });

  // #272-T04
  it("voids a failed job that reported no usage", () => {
    for (const result of [{ ok: false, usage: null }, { ok: false }, null])
      expect(
        settlementOfOutcome({ ok: false, errorCode: "checkout_failed", result }),
      ).toStrictEqual({ state: "void" });
    expect(
      settlementOfOutcome({ ok: false, errorCode: "checkout_failed" }),
    ).toStrictEqual({ state: "void" });
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

  it("does not trust a usage that is not what the runner API promises", () => {
    const damaged = { ...USAGE, promptTokens: -1 };
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "review_failed",
        result: { ok: false, usage: damaged },
      }),
    ).toStrictEqual({ state: "void" });
  });
});

describe("the key mode of a run", () => {
  // #272-T01
  it("is own for the workspace's key and managed for the operator's key", () => {
    expect(keyModeOfAccessSource("workspace")).toBe("own");
    expect(keyModeOfAccessSource("operator")).toBe("managed");
  });
});
