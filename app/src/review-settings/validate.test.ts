// Pins down which review settings are accepted: every field's range and format, that all problems of
// a request are reported at once with a stable code per field, that no value is echoed back, and
// that stored settings that are no longer valid are dropped instead of failing a review.
import { describe, expect, it } from "vitest";
import {
  REVIEW_SETTING_ISSUE_CODES,
  parseStoredOverrides,
  validateReviewSettingsPatch,
} from "./validate.ts";
import { REVIEW_SETTING_LIMITS } from "./settings.ts";

function issuesOf(input: unknown) {
  const result = validateReviewSettingsPatch(input);
  if (result.ok) throw new Error("expected the settings to be refused");
  return result.issues;
}

describe("validating review settings", () => {
  it("accepts a complete valid set and returns it normalized", () => {
    const result = validateReviewSettingsPatch({
      model: " qwen/qwen3-coder ",
      fallbackModel: "deepseek/deepseek-v3.2",
      extraInstructions: "Check the tests.\nBe brief.",
      maxFindings: 7,
      maxTokens: 120_000,
      largePrChunking: false,
      inlineKeyIssues: true,
      autoReviewOnOpen: false,
      autoReviewOnPush: true,
      allowedCommands: ["ask", "review"],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        model: "qwen/qwen3-coder",
        fallbackModel: "deepseek/deepseek-v3.2",
        extraInstructions: "Check the tests.\nBe brief.",
        maxFindings: 7,
        maxTokens: 120_000,
        largePrChunking: false,
        inlineKeyIssues: true,
        autoReviewOnOpen: false,
        autoReviewOnPush: true,
        allowedCommands: ["review", "ask"],
      },
    });
  });

  it("accepts a set with only some fields and leaves the others out", () => {
    expect(validateReviewSettingsPatch({ maxFindings: 3 })).toEqual({
      ok: true,
      value: { maxFindings: 3 },
    });
    expect(validateReviewSettingsPatch({})).toEqual({ ok: true, value: {} });
  });

  // CR-25-T07
  it.each([
    [0, "TOO_SMALL"],
    [-3, "TOO_SMALL"],
    [REVIEW_SETTING_LIMITS.maxFindings.max + 1, "TOO_LARGE"],
    [2.5, "INVALID_TYPE"],
    ["5", "INVALID_TYPE"],
    ["many", "INVALID_TYPE"],
    [Number.NaN, "INVALID_TYPE"],
    [null, "INVALID_TYPE"],
    [true, "INVALID_TYPE"],
  ])("refuses %j as the maximum number of findings with %s", (value, code) => {
    expect(issuesOf({ maxFindings: value })).toEqual([
      { field: "maxFindings", code },
    ]);
  });

  // CR-25-T07
  it.each([
    [REVIEW_SETTING_LIMITS.maxTokens.min - 1, "TOO_SMALL"],
    [32, "TOO_SMALL"],
    [0, "TOO_SMALL"],
    [REVIEW_SETTING_LIMITS.maxTokens.max + 1, "TOO_LARGE"],
    ["100000", "INVALID_TYPE"],
    [100_000.5, "INVALID_TYPE"],
  ])("refuses %j as the token budget with %s", (value, code) => {
    expect(issuesOf({ maxTokens: value })).toEqual([
      { field: "maxTokens", code },
    ]);
  });

  it("accepts the smallest and the largest token budget and number of findings", () => {
    for (const settings of [
      { maxTokens: REVIEW_SETTING_LIMITS.maxTokens.min },
      { maxTokens: REVIEW_SETTING_LIMITS.maxTokens.max },
      { maxFindings: REVIEW_SETTING_LIMITS.maxFindings.min },
      { maxFindings: REVIEW_SETTING_LIMITS.maxFindings.max },
    ])
      expect(validateReviewSettingsPatch(settings).ok).toBe(true);
  });

  // CR-25-T07
  it.each([
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["has a space", "INVALID_FORMAT"],
    ["-starts-with-dash", "INVALID_FORMAT"],
    ["x".repeat(201), "INVALID_FORMAT"],
    [42, "INVALID_TYPE"],
    [null, "INVALID_TYPE"],
  ])("refuses %j as the model with %s", (value, code) => {
    expect(issuesOf({ model: value })).toEqual([{ field: "model", code }]);
  });

  it("takes an empty or null fallback model as 'no fallback' and checks a given one like the model", () => {
    expect(validateReviewSettingsPatch({ fallbackModel: null })).toEqual({
      ok: true,
      value: { fallbackModel: null },
    });
    expect(validateReviewSettingsPatch({ fallbackModel: "  " })).toEqual({
      ok: true,
      value: { fallbackModel: null },
    });
    expect(issuesOf({ fallbackModel: "bad model" })).toEqual([
      { field: "fallbackModel", code: "INVALID_FORMAT" },
    ]);
    expect(issuesOf({ fallbackModel: 5 })).toEqual([
      { field: "fallbackModel", code: "INVALID_TYPE" },
    ]);
  });

  // CR-25-T08
  it("refuses project rules that are longer than the maximum, and accepts exactly the maximum", () => {
    const max = REVIEW_SETTING_LIMITS.extraInstructionsMaxChars;

    expect(
      validateReviewSettingsPatch({ extraInstructions: "a".repeat(max) }).ok,
    ).toBe(true);
    expect(issuesOf({ extraInstructions: "a".repeat(max + 1) })).toEqual([
      { field: "extraInstructions", code: "TOO_LONG" },
    ]);
  });

  it.each([
    ["a NUL character", "rule\u0000x"],
    ["an escape character", "rule\u001bx"],
    ["a lone surrogate", "rule\ud800x"],
  ])("refuses project rules with %s", (_label, text) => {
    expect(issuesOf({ extraInstructions: text })).toEqual([
      { field: "extraInstructions", code: "FORBIDDEN_CHARACTERS" },
    ]);
  });

  // CR-25-T06 (the text is kept as it is)
  it("keeps project rules with line breaks, quotes, equals signs and Unicode unchanged", () => {
    const text = 'Line one\r\nLine "two" = $x\tüber ✓ 🚀\n  indented';

    expect(validateReviewSettingsPatch({ extraInstructions: text })).toEqual({
      ok: true,
      value: { extraInstructions: text },
    });
  });

  it("refuses switches that are not booleans", () => {
    expect(
      issuesOf({
        largePrChunking: "yes",
        inlineKeyIssues: 1,
        autoReviewOnOpen: null,
        autoReviewOnPush: "true",
      }),
    ).toEqual([
      { field: "largePrChunking", code: "INVALID_TYPE" },
      { field: "inlineKeyIssues", code: "INVALID_TYPE" },
      { field: "autoReviewOnOpen", code: "INVALID_TYPE" },
      { field: "autoReviewOnPush", code: "INVALID_TYPE" },
    ]);
  });

  it("checks the list of allowed commands", () => {
    expect(validateReviewSettingsPatch({ allowedCommands: [] })).toEqual({
      ok: true,
      value: { allowedCommands: [] },
    });
    expect(issuesOf({ allowedCommands: ["review", "deploy"] })).toEqual([
      { field: "allowedCommands", code: "INVALID_FORMAT" },
    ]);
    expect(issuesOf({ allowedCommands: ["review", "review"] })).toEqual([
      { field: "allowedCommands", code: "DUPLICATE_ENTRY" },
    ]);
    expect(issuesOf({ allowedCommands: "review" })).toEqual([
      { field: "allowedCommands", code: "INVALID_TYPE" },
    ]);
    expect(issuesOf({ allowedCommands: [1] })).toEqual([
      { field: "allowedCommands", code: "INVALID_TYPE" },
    ]);
  });

  it("reports every problem of one request at once", () => {
    const issues = issuesOf({ maxFindings: 0, model: "", maxTokens: "x" });

    expect(issues.map((issue) => issue.field).sort()).toEqual([
      "maxFindings",
      "maxTokens",
      "model",
    ]);
  });

  it("refuses a field it does not know, naming it only when it looks like a plain name", () => {
    expect(issuesOf({ shellCommand: "rm" })).toEqual([
      { field: "shellCommand", code: "UNKNOWN_FIELD" },
    ]);
    expect(issuesOf({ "$(rm -rf /)": 1 })).toEqual([
      { field: "settings", code: "UNKNOWN_FIELD" },
    ]);
  });

  it("refuses input that is not an object", () => {
    for (const input of [null, "text", 3, [], [{ maxFindings: 1 }]])
      expect(issuesOf(input)).toEqual([
        { field: "settings", code: "INVALID_TYPE" },
      ]);
  });

  it("only uses issue codes from the stable list and never contains a value", () => {
    const secretLooking = "sk-dummy-should-not-be-echoed";
    const issues = issuesOf({
      model: `${secretLooking} x`,
      extraInstructions: 5,
      maxFindings: secretLooking,
    });

    for (const issue of issues)
      expect(REVIEW_SETTING_ISSUE_CODES).toContain(issue.code);
    expect(JSON.stringify(issues)).not.toContain(secretLooking);
  });
});

describe("reading stored review settings", () => {
  it("keeps valid fields and drops the ones that are invalid or unknown", () => {
    expect(
      parseStoredOverrides({
        maxFindings: 4,
        maxTokens: 5,
        model: "qwen/qwen3-coder",
        removedField: true,
        largePrChunking: "yes",
      }),
    ).toEqual({ maxFindings: 4, model: "qwen/qwen3-coder" });
  });

  it("treats anything that is not an object as no overrides", () => {
    for (const stored of [null, undefined, [], "x", 4])
      expect(parseStoredOverrides(stored)).toEqual({});
  });
});
