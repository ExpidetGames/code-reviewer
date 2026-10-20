// SPDX-License-Identifier: Apache-2.0

// The token cap of a run on the workspace's own key (#553): an instance setting with a default of 4,000,000 tokens that the
// admin can change within bounds. A stored value that is not valid reads as the default, never as no cap.
import { describe, expect, it } from "vitest";
import {
  checkOwnKeyTokenCap,
  DEFAULT_OWN_KEY_TOKEN_CAP,
  MAX_OWN_KEY_TOKEN_CAP,
  MIN_OWN_KEY_TOKEN_CAP,
  ownKeyTokenCapOf,
} from "./token-cap.ts";

describe("the token cap of an own key", () => {
  // #553-T11
  it("starts at four million tokens, about twice what the 55-call Sonnet run of #540 used", () => {
    expect(DEFAULT_OWN_KEY_TOKEN_CAP).toBe(4_000_000);
    expect(ownKeyTokenCapOf(undefined)).toBe(4_000_000);
  });

  // #553-T11
  it("accepts a whole number of tokens within the bounds", () => {
    for (const value of [
      MIN_OWN_KEY_TOKEN_CAP,
      1_000_000,
      4_000_000,
      MAX_OWN_KEY_TOKEN_CAP,
    ])
      expect(checkOwnKeyTokenCap(value)).toEqual({ ok: true, value });
  });

  // #553-T11
  it("refuses anything else: text, a fraction, a boolean, below or above the bounds, not finite", () => {
    for (const value of [
      "4000000",
      1.5,
      true,
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      MIN_OWN_KEY_TOKEN_CAP - 1,
      MAX_OWN_KEY_TOKEN_CAP + 1,
    ])
      expect(checkOwnKeyTokenCap(value)).toEqual({
        ok: false,
        code: "number_out_of_range",
      });
  });

  // #553-T11
  it("reads a stored value that is not valid as the default and never as no cap", () => {
    for (const stored of [0, -5, "x", null, 1e12, 3.2])
      expect(ownKeyTokenCapOf(stored)).toBe(DEFAULT_OWN_KEY_TOKEN_CAP);
    expect(ownKeyTokenCapOf(2_000_000)).toBe(2_000_000);
  });
});
