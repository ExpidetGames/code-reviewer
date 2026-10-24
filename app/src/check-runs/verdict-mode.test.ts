// SPDX-License-Identifier: Apache-2.0

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

describe("the verdict mode with a workspace default (#676)", () => {
  // #676-T02
  it("is the workspace default for a project that chose nothing", () => {
    expect(reviewVerdictOf({}, { reviewVerdict: "off" })).toBe("off");
    expect(reviewVerdictOf(undefined, { reviewVerdict: "any" })).toBe("any");
  });

  // #676-T02
  it("is the project's own mode where it chose one", () => {
    expect(
      reviewVerdictOf({ reviewVerdict: "any" }, { reviewVerdict: "off" }),
    ).toBe("any");
  });

  // #676-T02
  it("falls back to the default for a workspace default this version does not know, or none", () => {
    expect(reviewVerdictOf({}, { reviewVerdict: "sometimes" })).toBe(
      "blocking",
    );
    expect(reviewVerdictOf({}, undefined)).toBe("blocking");
    expect(reviewVerdictOf({}, "damaged")).toBe("blocking");
  });
});
