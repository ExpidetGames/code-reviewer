// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_TOKEN_BUDGET,
  reviewTokenBudget,
} from "./token-budget.ts";

// #689: no review setting names the token budget any more; the app decides it from the model's context window. Before, a
// managed job's budget was the workspace's value (default 100 000) cut down to the window of the entry's model (#280-T09,
// #434-T13), so the internal value keeps what every workspace that never changed it had.
describe("the internal token budget of a review", () => {
  // #689-T01
  it("is the built-in 100 000 while the context window of the model is not known", () => {
    expect(DEFAULT_REVIEW_TOKEN_BUDGET).toBe(100_000);
    expect(reviewTokenBudget(null)).toBe(DEFAULT_REVIEW_TOKEN_BUDGET);
  });

  // #689-T01
  it("is the built-in value when the window is larger, so a big window does not make a review bigger", () => {
    expect(reviewTokenBudget(200_000)).toBe(100_000);
    expect(reviewTokenBudget(1_000_000)).toBe(100_000);
    expect(reviewTokenBudget(100_000)).toBe(100_000);
  });

  // #689-T01
  it("is cut down to the context window of a smaller model", () => {
    expect(reviewTokenBudget(32_000)).toBe(32_000);
    expect(reviewTokenBudget(8_192)).toBe(8_192);
  });

  // #689-T01
  it("never goes below what a runner accepts", () => {
    expect(reviewTokenBudget(800)).toBe(1000);
    expect(reviewTokenBudget(0)).toBe(1000);
  });
});
