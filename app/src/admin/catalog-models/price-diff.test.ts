// SPDX-License-Identifier: Apache-2.0

// Which fields of a price differ between the confirmed one and the one now (#554): a stale price is shown with the fields that
// moved, so the admin does not have to compare two tables by eye.
import { describe, expect, it } from "vitest";
import { book } from "../../test-support/catalog-models-fixtures.ts";
import { changedPriceFields } from "./price-diff.ts";

const BASE = book("500000", "1000000", { cacheRead: "50000" });
const LEVEL = {
  input: "1",
  output: "2",
  cacheRead: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
};

describe("the fields of a price that differ", () => {
  // #554-T05
  it("is nothing for two equal prices", () => {
    expect(changedPriceFields(BASE, { ...BASE })).toEqual([]);
  });

  // #554-T05
  it("names the amounts that moved, in the order of the price table, and not the ones that did not", () => {
    const now = book("500000", "1000000", {
      cacheRead: "60000",
      reasoning: "2000000",
    });

    expect(changedPriceFields(BASE, now)).toEqual(["cacheRead", "reasoning"]);
  });

  // #554-T05
  it("names an amount that is gone or new", () => {
    const withReasoning = book("500000", "1000000", {
      cacheRead: "50000",
      reasoning: "3",
    });

    expect(changedPriceFields(withReasoning, BASE)).toEqual(["reasoning"]);
    expect(changedPriceFields(BASE, withReasoning)).toEqual(["reasoning"]);
  });

  // #554-T05
  it("names the older price over 200k tokens and the tiers", () => {
    const older = book("500000", "1000000", {
      cacheRead: "50000",
      contextOver200k: { ...LEVEL },
    });
    const tiered = book("500000", "1000000", {
      cacheRead: "50000",
      tiers: [{ ...LEVEL, contextOver: 200000 }],
    });

    expect(changedPriceFields(BASE, older)).toEqual(["contextOver200k"]);
    expect(
      changedPriceFields(older, {
        ...older,
        contextOver200k: { ...LEVEL, output: "9" },
      }),
    ).toEqual(["contextOver200k"]);
    expect(changedPriceFields(BASE, tiered)).toEqual(["tiers"]);
    expect(
      changedPriceFields(tiered, {
        ...tiered,
        tiers: [{ ...LEVEL, contextOver: 128000 }],
      }),
    ).toEqual(["tiers"]);
    expect(
      changedPriceFields(tiered, {
        ...tiered,
        tiers: [{ ...LEVEL, contextOver: 200000, cacheRead: "5" }],
      }),
    ).toEqual(["tiers"]);
  });

  // #554-T05
  it("is every amount the old price stated when the catalog states none now", () => {
    expect(changedPriceFields(BASE, null)).toEqual([
      "input",
      "output",
      "cacheRead",
    ]);
  });
});
