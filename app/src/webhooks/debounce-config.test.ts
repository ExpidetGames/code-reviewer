import { describe, expect, it } from "vitest";
import { AUTOMATIC_REVIEW_DEBOUNCE_MS } from "./automatic-review-policy.ts";
import { configuredDebounceMs } from "./debounce-config.ts";

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
