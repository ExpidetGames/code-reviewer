// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MEASURED_COST } from "../../e2e/helpers/measured-cost-pattern.ts";

// The pattern the operator journeys use to find a measured cost in a text that must not hold one. The fake reports
// 0.0001 US dollars with every answer. The first version of the pattern matched `1e-4` anywhere, which is also the end of
// one group of a UUID and the first digit of the next one (a run id `…a91e-4284…`), and failed a journey by chance.
const ID = "e0c4f1c2-a91e-4284-9b1a-6c1f0d3e2a11";
const FIRST_VERSION =
  /0\.0001\d*|1e-4|(?:costUsd|costMicroUsd|cost_micro_usd)[\\"\s:]*\d/;

describe("the pattern of a measured cost in a text", () => {
  // #434-X6
  it("is what the first version was not: blind to the digits of an id", () => {
    expect(FIRST_VERSION.test(`run ${ID} finished`)).toBe(true);
    expect(MEASURED_COST.test(`run ${ID} finished`)).toBe(false);
    expect(MEASURED_COST.test(`/runs/${ID}`)).toBe(false);
  });

  // #434-X6
  it("does not match inside any id a run can have", () => {
    const text = Array.from({ length: 5_000 }, () => randomUUID()).join(" ");
    expect(MEASURED_COST.exec(text)).toBeNull();
  });

  // #434-X6
  it.each([
    ['{"costUsd":1e-4}'],
    ['{"cost":1e-4,"tokens":3}'],
    ["cost 1e-4"],
    ["cost: 1e-4."],
    ["1e-4"],
    ["0.0001"],
    ["0.000123"],
    ['"costMicroUsd": 100'],
    ['"cost_micro_usd":12'],
    [`${ID} costs 1e-4`],
  ])("still finds a real measured cost: %s", (text) => {
    expect(MEASURED_COST.test(text)).toBe(true);
  });

  // #434-N-C
  it.each([
    ["a chunk file name", "static/chunks/app-z1e-4q.js"],
    ["a nanoid-like id", "run_Vx1e-4Qk3_9"],
    ["an id with a letter after it", "id q1e-4t"],
    ["an id with an underscore around it", "a_1e-4_b"],
  ])(
    "does not match inside %s: any letter, digit or underscore around it",
    (_name, text) => {
      expect(MEASURED_COST.test(text)).toBe(false);
    },
  );

  // #434-N-C
  it.each([["2.1e-4"], ["(1e-4)"], ['"1e-4"'], [":1e-4,"], ["- 1e-4 USD"]])(
    "still finds 1e-4 next to punctuation: %s",
    (text) => {
      expect(MEASURED_COST.test(text)).toBe(true);
    },
  );

  // #434-X6
  it("does not take the name of a cost field with no figure for a leak", () => {
    expect(MEASURED_COST.test('{"costUsd":null,"costHidden":true}')).toBe(
      false,
    );
  });
});
