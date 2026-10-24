// SPDX-License-Identifier: LicenseRef-Proprietary

// Which verdict mode a project's stored settings give (#405): its own choice when it is one this version knows,
// otherwise the default. A project without a row, with old settings or with a value from a newer version never
// breaks a review: it gets the default.
import { describe, expect, it } from "vitest";
import { reviewVerdictOf } from "./verdict-mode.ts";

describe("the verdict mode of stored project settings", () => {
  // #405-T28
  it("is the mode the project chose", () => {
    for (const mode of ["off", "blocking", "any"] as const)
      expect(reviewVerdictOf({ reviewVerdict: mode, maxFindings: 3 })).toBe(
        mode,
      );
  });

  // #405-T28
  it("is the default, blocking, for a project that chose nothing", () => {
    expect(reviewVerdictOf({})).toBe("blocking");
    expect(reviewVerdictOf({ reviewKind: "dynamic" })).toBe("blocking");
    expect(reviewVerdictOf(undefined)).toBe("blocking");
    expect(reviewVerdictOf(null)).toBe("blocking");
  });

  it("is the default for a value this version does not know", () => {
    for (const stored of ["sometimes", 5, null, {}, []])
      expect(reviewVerdictOf({ reviewVerdict: stored })).toBe("blocking");
  });
});
