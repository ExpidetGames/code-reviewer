// Pins down that every stable code a settings field or a save can fail with has copy that says what
// to do, never shows the raw code, and names the limit where there is one.
import { describe, expect, it } from "vitest";
import { REVIEW_SETTING_ISSUE_CODES } from "../validate.ts";
import { REVIEW_SETTINGS_ERROR_CODES } from "../errors.ts";
import { REVIEW_SETTING_FIELDS, REVIEW_SETTING_LIMITS } from "../settings.ts";
import { TRANSPORT_ERROR_CODES } from "../../ui/json-request.ts";
import { describeIssue, describeSaveFailure } from "./messages.ts";

describe("the copy for a problem with one setting", () => {
  // CR-34-T06
  it.each(REVIEW_SETTING_ISSUE_CODES)(
    "has a sentence for %s on every field that is not the code itself",
    (code) => {
      for (const field of REVIEW_SETTING_FIELDS) {
        const text = describeIssue(field, code);

        expect(text, `${field} ${code}`).not.toBe("");
        expect(text, `${field} ${code}`).not.toContain(code);
      }
    },
  );

  // CR-34-T06
  it("names the limits of the number fields", () => {
    expect(describeIssue("maxFindings", "TOO_SMALL")).toBe(
      `Enter ${String(REVIEW_SETTING_LIMITS.maxFindings.min)} or more.`,
    );
    expect(describeIssue("maxFindings", "TOO_LARGE")).toBe(
      `Enter ${String(REVIEW_SETTING_LIMITS.maxFindings.max)} or less.`,
    );
    expect(describeIssue("maxTokens", "TOO_SMALL")).toMatch(/8,000/);
  });

  // CR-34-T06
  it("asks for a whole number where a number field holds something else", () => {
    expect(describeIssue("maxTokens", "INVALID_TYPE")).toBe(
      "Enter a whole number.",
    );
  });

  // CR-34-T06
  it("names the length limit of the project rules", () => {
    expect(describeIssue("extraInstructions", "TOO_LONG")).toMatch(/4,000/);
  });

  // CR-34-T06
  it("says an unknown command is not one of the four", () => {
    expect(describeIssue("allowedCommands", "INVALID_FORMAT")).toMatch(
      /review, improve, describe and ask/,
    );
  });

  // CR-34-T06
  it("says an empty required field needs a value", () => {
    expect(describeIssue("model", "EMPTY")).toBe("Enter a model name.");
  });

  it("explains a token budget that does not fit the model's context window, on either field", () => {
    expect(describeIssue("maxTokens", "EXCEEDS_MODEL_CONTEXT")).toMatch(
      /context window/,
    );
    expect(describeIssue("model", "EXCEEDS_MODEL_CONTEXT")).toMatch(
      /context window/,
    );
    expect(describeIssue("fallbackModel", "EXCEEDS_MODEL_CONTEXT")).toMatch(
      /context window/,
    );
  });

  it("falls back to a generic sentence for a field or code it does not know", () => {
    expect(describeIssue("somethingNew", "SOMETHING_NEW")).toBe(
      "This value is not valid.",
    );
  });
});

describe("the copy for a save that failed as a whole", () => {
  it.each([...REVIEW_SETTINGS_ERROR_CODES, ...TRANSPORT_ERROR_CODES])(
    "has a sentence for %s that is not the code itself",
    (code) => {
      const text = describeSaveFailure(code);

      expect(text).not.toBe("");
      expect(text).not.toContain(code);
    },
  );

  it("tells the person to fix the marked fields when the settings were not valid", () => {
    expect(describeSaveFailure("REVIEW_SETTINGS_INVALID")).toMatch(/marked/);
  });

  it("says a project that was never activated has no settings yet", () => {
    expect(describeSaveFailure("REVIEW_SETTINGS_PROJECT_NOT_FOUND")).toMatch(
      /activate/i,
    );
  });
});
