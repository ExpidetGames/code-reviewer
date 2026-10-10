import { describe, expect, it } from "vitest";
import { AUTOMATIC_REVIEW_DEBOUNCE_MS } from "./automatic-review-policy.ts";
import {
  configuredDebounceMs,
  debounceWarning,
  warnAboutDebounce,
} from "./debounce-config.ts";

describe("the wait of a push before its review starts", () => {
  it("is 90 seconds when nothing is configured", () => {
    expect(configuredDebounceMs({})).toBe(AUTOMATIC_REVIEW_DEBOUNCE_MS);
    expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: "" })).toBe(90_000);
    expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: "  " })).toBe(
      90_000,
    );
  });

  it("follows REVIEW_DEBOUNCE_SECONDS, which may be zero to switch the wait off", () => {
    expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: "60" })).toBe(
      60_000,
    );
    expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: " 120 " })).toBe(
      120_000,
    );
    expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: "0" })).toBe(0);
  });

  it.each(["abc", "-5", "1.5", "601", "1e3", "NaN", "90s"])(
    "falls back to the default for the value %j",
    (value) => {
      expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: value })).toBe(
        90_000,
      );
    },
  );
});

describe("the warning about an unusable wait", () => {
  it("is silent for an unset, empty or valid value", () => {
    for (const value of [undefined, "", "0", "90", "600"])
      expect(debounceWarning({ REVIEW_DEBOUNCE_SECONDS: value })).toBeNull();
  });

  it("names the variable and the default, and never repeats the value", () => {
    const line = debounceWarning({ REVIEW_DEBOUNCE_SECONDS: "900" });

    expect(line).toContain("REVIEW_DEBOUNCE_SECONDS");
    expect(line).toContain("90 seconds");
    expect(line).not.toContain("900");
  });

  it("is logged once through the given function", () => {
    const lines: string[] = [];

    warnAboutDebounce({ REVIEW_DEBOUNCE_SECONDS: "soon" }, (l) =>
      lines.push(l),
    );
    warnAboutDebounce({}, (l) => lines.push(l));

    expect(lines).toHaveLength(1);
  });
});
