// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { testInlineRetryDelays } from "./test-timing.ts";

const ON = { ALLOW_TEST_DISPATCH_TIMING: "true" };

describe("the test-only pauses of the inline retries", () => {
  // #395-T06
  it("are read only with the flag", () => {
    expect(
      testInlineRetryDelays({
        ...ON,
        TEST_DISPATCH_INLINE_RETRY_DELAYS_MS: "2000, 6000,10000",
      }),
    ).toEqual([2000, 6000, 10000]);
    for (const env of [
      { TEST_DISPATCH_INLINE_RETRY_DELAYS_MS: "2000" },
      {
        ALLOW_TEST_DISPATCH_TIMING: "yes",
        TEST_DISPATCH_INLINE_RETRY_DELAYS_MS: "2000",
      },
      ON,
    ])
      expect(testInlineRetryDelays(env)).toBeUndefined();
  });

  // #395-T06
  it.each([
    "abc",
    "-1",
    "1.5",
    "10001",
    "1,2,3,4,5,6",
    "100000",
    ",",
    "2000;3000",
  ])("ignore the value %j", (value) => {
    expect(
      testInlineRetryDelays({
        ...ON,
        TEST_DISPATCH_INLINE_RETRY_DELAYS_MS: value,
      }),
    ).toBeUndefined();
  });
});
