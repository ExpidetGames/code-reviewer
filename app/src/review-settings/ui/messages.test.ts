// SPDX-License-Identifier: Apache-2.0

// Pins down that every stable code a settings field or a save can fail with has copy that says what
// to do, never shows the raw code, and names the limit where there is one.
import { describe, expect, it } from "vitest";
import {
  REVIEW_SETTING_ISSUE_CODES,
  REVIEW_SETTING_WARNING_CODES,
} from "../validate.ts";
import { REVIEW_SETTINGS_ERROR_CODES } from "../errors.ts";
import {
  PROJECT_DYNAMIC_LIMITS,
  PROJECT_DYNAMIC_SETTING_FIELDS,
  REVIEW_SETTING_FIELDS,
  REVIEW_SETTING_LIMITS,
} from "../settings.ts";
import { TRANSPORT_ERROR_CODES } from "../../ui/json-request.ts";
import {
  describeIssue,
  describeSaveFailure,
  describeWarning,
} from "./messages.ts";

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

  // CR-34-T06, #203
  it("says an unknown command is not one that exists", () => {
    expect(describeIssue("allowedCommands", "INVALID_FORMAT")).toMatch(
      /Only the command review exists/,
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

  // #200-T03
  it.each(REVIEW_SETTING_ISSUE_CODES)(
    "has a sentence for %s on every project-only field that is not the code itself",
    (code) => {
      for (const field of PROJECT_DYNAMIC_SETTING_FIELDS) {
        const text = describeIssue(field, code);

        expect(text, `${field} ${code}`).not.toBe("");
        expect(text, `${field} ${code}`).not.toContain(code);
      }
    },
  );

  // #200-T03
  it("names the byte limit of the review skill and says that multibyte characters count as their bytes", () => {
    const text = describeIssue("reviewSkill", "TOO_LONG");

    expect(text).toContain(
      PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes.toLocaleString("en-US"),
    );
    expect(text).toMatch(/bytes/);
  });

  // #200-T03
  it("tells the person to reset the skill instead of saving it empty", () => {
    expect(describeIssue("reviewSkill", "EMPTY")).toMatch(/reset/i);
  });

  // #200-T03
  it("asks for a model name of the provider for the Dynamic model, not for an OpenRouter one", () => {
    expect(describeIssue("dynamicModel", "EMPTY")).toBe("Enter a model name.");
    expect(describeIssue("dynamicModel", "INVALID_FORMAT")).toMatch(
      /deepseek\/deepseek-v4\.1-flash/,
    );
  });

  // #433-T07
  it.each([
    "PROVIDER_UNKNOWN",
    "CATALOG_ENTRY_UNKNOWN",
    "CATALOG_ENTRY_NOT_RELEASED",
    "CATALOG_ENTRY_KIND_MISMATCH",
    "CATALOG_ENTRY_NOT_ALLOWED",
    "CATALOG_ENTRY_OWN_KEY_MODE",
    "MODEL_MANAGED_BY_INSTANCE",
  ] as const satisfies readonly (typeof REVIEW_SETTING_ISSUE_CODES)[number][])(
    "has a specific sentence for %s on every provider and catalog field",
    (code) => {
      for (const field of [
        "provider",
        "dynamicProvider",
        "catalogEntryDiff",
        "catalogEntryDynamic",
      ]) {
        const text = describeIssue(field, code);

        expect(text, `${field} ${code}`).not.toBe("This value is not valid.");
        expect(text, `${field} ${code}`).not.toContain(code);
      }
    },
  );

  // #433-T07
  it.each(["INVALID_TYPE", "EMPTY", "TOO_LONG", "INVALID_FORMAT"] as const)(
    "does not call a provider or an entry a model name when %s is reported for it",
    (code) => {
      for (const field of ["provider", "dynamicProvider"])
        expect(describeIssue(field, code), `${field} ${code}`).toMatch(
          /provider/i,
        );
      for (const field of ["catalogEntryDiff", "catalogEntryDynamic"]) {
        const text = describeIssue(field, code);
        expect(text, `${field} ${code}`).toMatch(/choice|option|listed/i);
        expect(text, `${field} ${code}`).not.toMatch(/model/i);
      }
    },
  );

  // #433-T07
  it("tells a workspace on its own key that choices come with the key of the instance", () => {
    const text = describeIssue(
      "catalogEntryDiff",
      "CATALOG_ENTRY_OWN_KEY_MODE",
    );

    expect(text).toMatch(/own AI key/);
    expect(text).toMatch(/once the AI access comes from this instance/);
  });

  // #433-T07
  it("names the kind in the sentence about an entry that does not serve it", () => {
    expect(
      describeIssue("catalogEntryDiff", "CATALOG_ENTRY_KIND_MISMATCH"),
    ).toMatch(/Diff Review/);
    expect(
      describeIssue("catalogEntryDynamic", "CATALOG_ENTRY_KIND_MISMATCH"),
    ).toMatch(/Dynamic Review/);
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

  it("says the repository was not found when it is gone", () => {
    expect(describeSaveFailure("REVIEW_SETTINGS_PROJECT_NOT_FOUND")).toMatch(
      /not found/i,
    );
  });
});

// #269-T05 #269-T06 #269-T07
describe("the copy for the check of the Dynamic model", () => {
  it("says in plain words what each outcome means", () => {
    expect(
      describeIssue("dynamicModel", "DYNAMIC_MODEL_TOOLS_UNSUPPORTED"),
    ).toMatch(/does not support tool calling/);
    expect(describeIssue("dynamicModel", "DYNAMIC_MODEL_UNKNOWN")).toMatch(
      /no model with this name/,
    );
  });

  it.each(REVIEW_SETTING_WARNING_CODES)(
    "has a sentence for the warning %s that is not the code itself",
    (code) => {
      const text = describeWarning("dynamicModel", code);

      expect(text).not.toBe("");
      expect(text).not.toContain(code);
    },
  );

  it("does not invent a sentence for a warning it does not know", () => {
    expect(describeWarning("dynamicModel", "SOMETHING_NEW")).toBeNull();
  });
});
