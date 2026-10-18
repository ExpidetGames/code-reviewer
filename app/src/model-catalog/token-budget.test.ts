// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { clampMaxTokens, UNKNOWN_WINDOW_MAX_TOKENS } from "./token-budget.ts";

// The clamp existed for the managed tiers (#280-T09) and moved here with them (#434): a managed job's model is not the
// workspace's to see, so the workspace cannot know its context window either.
describe("the token budget of a managed job", () => {
  // #434-T11
  it("is clamped to the context window of the entry's model when it is above", () => {
    expect(clampMaxTokens(500_000, 200_000)).toBe(200_000);
  });

  // #434-T11
  it("is left alone when it fits", () => {
    expect(clampMaxTokens(100_000, 200_000)).toBe(100_000);
    expect(clampMaxTokens(200_000, 200_000)).toBe(200_000);
  });

  // #434-T11
  it("is never sent unclamped: with no window known it is cut to a conservative bound", () => {
    expect(UNKNOWN_WINDOW_MAX_TOKENS).toBe(100_000);
    expect(clampMaxTokens(2_000_000, null)).toBe(UNKNOWN_WINDOW_MAX_TOKENS);
    expect(clampMaxTokens(500_000, null)).toBe(UNKNOWN_WINDOW_MAX_TOKENS);
    expect(clampMaxTokens(50_000, null)).toBe(50_000);
  });

  // #434-T11
  it("never clamps below what a runner accepts", () => {
    expect(clampMaxTokens(500_000, 800)).toBe(1000);
  });
});
