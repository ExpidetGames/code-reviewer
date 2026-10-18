// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  PLAN_ERROR_CODES,
  PLAN_ERROR_STATUS,
} from "../../billing/plan-errors.ts";
import {
  PRICE_ERROR_STATUS,
  PRICE_LINK_ERROR_CODES,
} from "../../billing/price-errors.ts";
import { GENERIC_FAILURE } from "../../ui/transport-messages.ts";
import { describePlanFailure } from "./plans-messages.ts";

describe("the copy of the plans page", () => {
  // #438-N6
  it("tells the admin something specific for every code the plans routes can answer", () => {
    // The client cannot import the codes (they are server code), so the copy is a plain table; this is what keeps the
    // two in step when a code is added.
    for (const code of PLAN_ERROR_CODES)
      expect(describePlanFailure(code), code).not.toBe(GENERIC_FAILURE);
    expect(Object.keys(PLAN_ERROR_STATUS).sort()).toEqual(
      [...PLAN_ERROR_CODES].sort(),
    );
  });

  // #438-N6
  it("falls back to the generic sentence for a code it does not know, so the test above can fail", () => {
    expect(describePlanFailure("a_code_nobody_wrote_copy_for")).toBe(
      GENERIC_FAILURE,
    );
  });

  // #438-N6
  it("gives every code a sentence of its own", () => {
    const sentences = PLAN_ERROR_CODES.map((code) => describePlanFailure(code));

    expect(new Set(sentences).size).toBe(sentences.length);
  });

  // #439-T02
  it("tells the admin something specific, and different, for every code a price link can be refused with", () => {
    const sentences = PRICE_LINK_ERROR_CODES.map((code) => {
      const sentence = describePlanFailure(code);
      expect(sentence, code).not.toBe(GENERIC_FAILURE);
      return sentence;
    });

    expect(new Set(sentences).size).toBe(sentences.length);
  });

  // #439-T02
  it("gives the HTTP status of every code a price link can be refused with", () => {
    for (const code of PRICE_LINK_ERROR_CODES)
      expect(PRICE_ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
  });
});
