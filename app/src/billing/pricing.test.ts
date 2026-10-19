// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTCOME_CLASSES, type OutcomeClass } from "./outcome.ts";
import { PricingError, priceRun, reserveFor } from "./pricing.ts";
import type { BillingRates } from "./rates.ts";

// Made-up numbers: no rate that anybody charges is in this file.
const RATES: BillingRates = {
  factorA: 12_000,
  minuteRateMicroUsd: { diff: 10_000, dynamic: 25_000 },
  diffAiReserveMicroUsd: 400_000,
};

type RunFacts = Parameters<typeof priceRun>[0];

function run(facts: Partial<RunFacts>) {
  return priceRun({
    keyMode: "managed",
    outcomeClass: "charged",
    costMicroUsd: 1_000_000,
    billableMinutes: 3,
    reviewKind: "diff",
    rates: RATES,
    ...facts,
  });
}

describe("the price of a run", () => {
  // #494-T01
  it("is the cost times A plus the started minutes times B", () => {
    expect(run({})).toStrictEqual({
      aiMicroUsd: 1_200_000,
      infraMicroUsd: 30_000,
      totalMicroUsd: 1_230_000,
    });
  });

  // #494-T01
  it.each([
    ["diff", 30_000],
    ["dynamic", 75_000],
  ] as const)("takes the rate of the review kind: %s", (reviewKind, infra) => {
    expect(run({ reviewKind }).infraMicroUsd).toBe(infra);
  });

  // #494-T02
  it.each([
    // cost, A, the exact value cost x A / 10,000, the price (half up)
    [1, 14_900, "1.49", 1],
    [1, 15_000, "1.50", 2],
    [1, 15_100, "1.51", 2],
    [1, 25_000, "2.50", 3], // half up, not to even
    [3, 10_001, "3.0003", 3],
    [5, 11_000, "5.50", 6],
    [9, 10_500, "9.45", 9],
    [9, 10_555, "9.4995", 9],
    [9, 10_556, "9.5004", 10],
  ])(
    "rounds the AI price of cost %i at A %i (%s) half up to %i",
    (costMicroUsd, factorA, _exact, expected) => {
      expect(
        run({
          costMicroUsd,
          rates: { ...RATES, factorA },
          billableMinutes: 0,
        }).aiMicroUsd,
      ).toBe(expected);
    },
  );

  // #494-T02
  it("rounds the AI price once, on the whole cost, not per part", () => {
    // 3 x 12,500 = 37,500 -> 3.75 -> 4; as three runs of 1 it would be 1.25 -> 1 each, 3 in all.
    expect(
      run({ costMicroUsd: 3, rates: { ...RATES, factorA: 12_500 } }).aiMicroUsd,
    ).toBe(4);
  });

  // #494-T02
  it("needs no rounding for the infrastructure price: whole minutes times a whole rate", () => {
    expect(run({ billableMinutes: 7 }).infraMicroUsd).toBe(70_000);
    expect(run({ billableMinutes: 0 }).infraMicroUsd).toBe(0);
  });

  // #494-T02
  it.each([0.5, 1.49, 2.5])(
    "refuses %s started minutes: minutes are whole",
    (billableMinutes) => {
      expect(() => run({ billableMinutes })).toThrowError(
        expect.objectContaining({ code: "pricing_input_invalid" }),
      );
    },
  );

  // #494-T03
  it("charges no AI for a run on the workspace's own key, whatever it cost", () => {
    expect(run({ keyMode: "own", costMicroUsd: 9_000_000 })).toStrictEqual({
      aiMicroUsd: 0,
      infraMicroUsd: 30_000,
      totalMicroUsd: 30_000,
    });
  });

  // #494-T04
  it("charges no AI for a managed run whose cost is unknown, but its minutes", () => {
    expect(run({ costMicroUsd: null })).toStrictEqual({
      aiMicroUsd: 0,
      infraMicroUsd: 30_000,
      totalMicroUsd: 30_000,
    });
  });

  // #494-T05
  it("has no minimum: a run that costs nothing and needs no minute charges nothing", () => {
    expect(run({ costMicroUsd: 0, billableMinutes: 0 })).toStrictEqual({
      aiMicroUsd: 0,
      infraMicroUsd: 0,
      totalMicroUsd: 0,
    });
  });

  // #494-T05
  it("charges a rate of 0 nothing for the minutes (an operator who does not charge for them)", () => {
    const rates = { ...RATES, minuteRateMicroUsd: { diff: 0, dynamic: 0 } };
    expect(run({ rates, costMicroUsd: null }).totalMicroUsd).toBe(0);
  });
});

describe("the price by the class of the outcome", () => {
  const cases: Array<[OutcomeClass, "managed" | "own", number, number]> = [
    // class, key mode, expected AI, expected infrastructure (cost 1,000,000, 3 minutes, Diff)
    ["charged", "managed", 1_200_000, 30_000],
    ["charged", "own", 0, 30_000],
    ["minutes_only", "managed", 0, 30_000],
    ["minutes_only", "own", 0, 30_000],
    ["free", "managed", 0, 0],
    ["free", "own", 0, 0],
  ];

  // #494-T06
  it.each(cases)(
    "class %s, key mode %s: AI %i, infrastructure %i",
    (outcomeClass, keyMode, ai, infra) => {
      expect(run({ outcomeClass, keyMode })).toStrictEqual({
        aiMicroUsd: ai,
        infraMicroUsd: infra,
        totalMicroUsd: ai + infra,
      });
    },
  );

  // #494-T06
  it("covers every class in the table above", () => {
    for (const outcomeClass of OUTCOME_CLASSES)
      expect(
        cases.some(([candidate]) => candidate === outcomeClass),
        outcomeClass,
      ).toBe(true);
  });

  // #494-T07
  it("charges a superseded run that reported AI and minutes, one that did not minutes only", () => {
    // Both are the class `charged`: the cost decides (the reported one, or unknown).
    expect(
      run({ outcomeClass: "charged", costMicroUsd: 500_000 }),
    ).toMatchObject({ aiMicroUsd: 600_000, infraMicroUsd: 30_000 });
    expect(run({ outcomeClass: "charged", costMicroUsd: null })).toMatchObject({
      aiMicroUsd: 0,
      infraMicroUsd: 30_000,
    });
  });

  // #494-T06
  it("does not look at the facts of a run that costs nothing", () => {
    expect(
      run({
        outcomeClass: "free",
        costMicroUsd: -1,
        billableMinutes: Number.NaN,
      }),
    ).toStrictEqual({ aiMicroUsd: 0, infraMicroUsd: 0, totalMicroUsd: 0 });
  });
});

describe("the limits of the arithmetic", () => {
  // #494-T12
  it("computes a large cost exactly, in integers", () => {
    // 4,000,000,000,000 micro-USD (4 million USD) x 1.2 = 4,800,000,000,000: far above 2^32, far below 2^53.
    expect(
      run({ costMicroUsd: 4_000_000_000_000, billableMinutes: 0 }).aiMicroUsd,
    ).toBe(4_800_000_000_000);
  });

  // #494-T12
  it("refuses a result above the safe integer range instead of wrapping it", () => {
    expect(() =>
      run({ costMicroUsd: Number.MAX_SAFE_INTEGER, billableMinutes: 0 }),
    ).toThrowError(
      expect.objectContaining({ code: "pricing_amount_overflow" }),
    );
  });

  // #494-T12
  it("refuses a total above the safe integer range, though each part fits", () => {
    const rates = { ...RATES, factorA: 10_000 };
    expect(() =>
      run({
        rates: {
          ...rates,
          minuteRateMicroUsd: { diff: 10_000_000, dynamic: 1 },
        },
        costMicroUsd: Number.MAX_SAFE_INTEGER - 1,
        billableMinutes: 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "pricing_amount_overflow" }),
    );
  });

  // #494-T12
  it("refuses minutes whose price is above the safe integer range", () => {
    expect(() =>
      run({ costMicroUsd: null, billableMinutes: Number.MAX_SAFE_INTEGER }),
    ).toThrowError(
      expect.objectContaining({ code: "pricing_amount_overflow" }),
    );
  });

  // #494-T12
  it.each([
    ["a minutes-only run", { outcomeClass: "minutes_only" }],
    ["a run on the workspace's own key", { keyMode: "own" }],
  ] as Array<[string, Partial<RunFacts>]>)(
    "does not look at a cost it does not use: %s",
    (_name, facts) => {
      for (const costMicroUsd of [Number.NaN, -1, 1.5, 2 ** 53])
        expect(run({ ...facts, costMicroUsd })).toStrictEqual({
          aiMicroUsd: 0,
          infraMicroUsd: 30_000,
          totalMicroUsd: 30_000,
        });
    },
  );

  // #494-T12
  it.each([
    ["a negative cost", { costMicroUsd: -1 }],
    ["a fractional cost", { costMicroUsd: 1.5 }],
    ["a cost that is not a number", { costMicroUsd: Number.NaN }],
    ["an infinite cost", { costMicroUsd: Number.POSITIVE_INFINITY }],
    ["a cost above the safe integers", { costMicroUsd: 2 ** 53 }],
    ["negative minutes", { billableMinutes: -1 }],
    ["minutes that are not a number", { billableMinutes: Number.NaN }],
  ] as Array<[string, Partial<RunFacts>]>)("refuses %s", (_name, facts) => {
    expect(() => run(facts)).toThrowError(PricingError);
    expect(() => run(facts)).toThrowError(
      expect.objectContaining({ code: "pricing_input_invalid" }),
    );
  });

  // #494-T12
  it.each([
    ["a factor below 1", { ...RATES, factorA: 9_999 }],
    ["a fractional factor", { ...RATES, factorA: 12_000.5 }],
    [
      "a negative rate",
      { ...RATES, minuteRateMicroUsd: { diff: -1, dynamic: 0 } },
    ],
    [
      "a fractional rate",
      { ...RATES, minuteRateMicroUsd: { diff: 0.5, dynamic: 0 } },
    ],
  ])("refuses rates with %s, so a price is never negative", (_name, rates) => {
    expect(() => run({ rates })).toThrowError(
      expect.objectContaining({ code: "pricing_rates_invalid" }),
    );
  });

  // #494-T05
  it("never returns a negative amount, over a sweep of the inputs", () => {
    for (const cost of [null, 0, 1, 7, 1_000_000])
      for (const minutes of [0, 1, 59])
        for (const outcomeClass of OUTCOME_CLASSES)
          for (const keyMode of ["managed", "own"] as const) {
            const price = run({
              costMicroUsd: cost,
              billableMinutes: minutes,
              outcomeClass,
              keyMode,
            });
            expect(price.aiMicroUsd).toBeGreaterThanOrEqual(0);
            expect(price.infraMicroUsd).toBeGreaterThanOrEqual(0);
            expect(price.totalMicroUsd).toBe(
              price.aiMicroUsd + price.infraMicroUsd,
            );
          }
  });
});

describe("the hold of a job", () => {
  // The hold of ADR 0006, D6: the longest the VM lives times B, plus for the managed key the AI budget times A.
  const hold = (facts: Partial<Parameters<typeof reserveFor>[0]>) =>
    reserveFor({
      keyMode: "managed",
      reviewKind: "dynamic",
      maxMinutes: 40,
      rates: RATES,
      dynamicCostLimitMicroUsd: 2_000_000,
      ...facts,
    });

  // #494-T09
  it("holds minutes times B plus the cost limit times A for Dynamic on the managed key", () => {
    expect(hold({})).toStrictEqual({
      aiMicroUsd: 2_400_000,
      infraMicroUsd: 1_000_000,
      totalMicroUsd: 3_400_000,
    });
  });

  // #494-T09
  it("holds only the minutes for Dynamic on the workspace's own key", () => {
    expect(hold({ keyMode: "own" })).toStrictEqual({
      aiMicroUsd: 0,
      infraMicroUsd: 1_000_000,
      totalMicroUsd: 1_000_000,
    });
  });

  // #494-T09
  it("holds the minutes of the Diff rate plus the Diff AI reserve times A for Diff on the managed key", () => {
    expect(
      hold({
        reviewKind: "diff",
        maxMinutes: 15,
        dynamicCostLimitMicroUsd: null,
      }),
    ).toStrictEqual({
      aiMicroUsd: 480_000,
      infraMicroUsd: 150_000,
      totalMicroUsd: 630_000,
    });
  });

  // #494-T09
  it("holds only the minutes for Diff on the workspace's own key", () => {
    expect(
      hold({
        reviewKind: "diff",
        keyMode: "own",
        maxMinutes: 15,
        dynamicCostLimitMicroUsd: null,
      }),
    ).toStrictEqual({
      aiMicroUsd: 0,
      infraMicroUsd: 150_000,
      totalMicroUsd: 150_000,
    });
  });

  // #494-T09
  it("does not read the cost limit of a Diff job nor of a job on the workspace's own key", () => {
    expect(
      hold({ reviewKind: "diff", dynamicCostLimitMicroUsd: 99 }).aiMicroUsd,
    ).toBe(480_000);
    expect(
      hold({ keyMode: "own", dynamicCostLimitMicroUsd: null }).aiMicroUsd,
    ).toBe(0);
  });

  // #494-T09
  it("rounds the AI part half up, once, like the price", () => {
    expect(
      hold({
        dynamicCostLimitMicroUsd: 1,
        rates: { ...RATES, factorA: 15_000 },
        maxMinutes: 0,
      }).aiMicroUsd,
    ).toBe(2);
  });

  // #494-T09
  it("rounds the minutes up: a fraction of a minute is a started minute", () => {
    expect(hold({ maxMinutes: 40.2, keyMode: "own" }).infraMicroUsd).toBe(
      41 * 25_000,
    );
  });

  // #494-T09
  it("refuses a Dynamic job on the managed key without a cost limit", () => {
    expect(() => hold({ dynamicCostLimitMicroUsd: null })).toThrowError(
      expect.objectContaining({ code: "pricing_input_invalid" }),
    );
  });

  // #494-T12
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s maximum minutes",
    (maxMinutes) => {
      expect(() => hold({ maxMinutes })).toThrowError(PricingError);
    },
  );

  // #494-T12
  it("refuses a hold above the safe integer range", () => {
    expect(() =>
      hold({ dynamicCostLimitMicroUsd: Number.MAX_SAFE_INTEGER }),
    ).toThrowError(
      expect.objectContaining({ code: "pricing_amount_overflow" }),
    );
  });
});

describe("the module", () => {
  const sources = ["pricing.ts", "outcome.ts", "rates.ts"].map((file) => [
    file,
    readFileSync(new URL(file, import.meta.url), "utf8"),
  ]);

  // #494-T13
  it.each(sources)(
    "%s imports no database, clock or network",
    (_file, text) => {
      const specifiers = [
        ...String(text).matchAll(
          /from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g,
        ),
      ].map((match) => match[1] ?? match[2] ?? "");
      for (const specifier of specifiers)
        expect(specifier, `${_file} imports ${specifier}`).toMatch(
          /^(\.\/[a-z-]+\.ts|\.\.\/[a-z-]+\/[a-z-]+\.ts|server-only)$/,
        );
      for (const specifier of specifiers)
        expect(specifier).not.toMatch(/\/(db|jobs-repository|http|dispatch)\b/);
      const code = String(text).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      expect(code).not.toMatch(
        /\bnew Date\b|\bDate\.now\b|\bfetch\(|\bprocess\.|\bMath\.random\b|\bperformance\.now\b|\bsetTimeout\b/,
      );
    },
  );

  // #494-T13
  it("uses no floating point on an amount", () => {
    const code = String(sources[0]?.[1]).replace(
      /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      "",
    );
    expect(code).not.toMatch(
      /\bMath\.(round|floor|pow)\b|parseFloat|toFixed|\*\*/,
    );
  });
});
