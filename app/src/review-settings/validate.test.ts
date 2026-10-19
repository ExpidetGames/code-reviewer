// SPDX-License-Identifier: Apache-2.0

// Pins down which review settings are accepted: every field's range and format, that all problems of
// a request are reported at once with a stable code per field, that no value is echoed back, and
// that stored settings that are no longer valid are dropped instead of failing a review.
import { describe, expect, it } from "vitest";
import { createFakeAdapter } from "../llm/providers/fake-adapter.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { createProviderRegistry } from "../llm/providers/registry.ts";
import {
  REVIEW_SETTING_ISSUE_CODES,
  parseStoredOverrides,
  parseStoredProjectDynamicOverrides,
  validateProjectSettingsPatch,
  validateReviewSettingsPatch,
} from "./validate.ts";
import {
  PROJECT_DYNAMIC_LIMITS,
  REVIEW_SETTING_LIMITS,
  builtInReviewSettings,
} from "./settings.ts";
import { isCommandAllowed, resolveReviewSettings } from "./effective.ts";

function issuesOf(input: unknown) {
  const result = validateReviewSettingsPatch(input);
  if (result.ok) throw new Error("expected the settings to be refused");
  return result.issues;
}

function projectIssuesOf(input: unknown) {
  const result = validateProjectSettingsPatch(input);
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
      allowedCommands: ["review"],
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
        allowedCommands: ["review"],
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

// #203-T08: a stored allowedCommands list is the critical seam. A field dropped by a generic reader
// would let an enabled lower layer win, so the removed-only case must stay `[]` and effective.
describe("the legacy allowedCommands seam", () => {
  it.each([
    [["ask"], []],
    [["improve", "describe"], []],
    [["review", "ask"], ["review"]],
    [["ask", "review", "improve"], ["review"]],
    [[], []],
    [["review"], ["review"]],
  ])("intersects the stored list %j to %j", (stored, expected) => {
    expect(parseStoredOverrides({ allowedCommands: stored })).toEqual({
      allowedCommands: expected,
    });
  });

  it("leaves a missing field to inherit and ignores a list that is not an array", () => {
    expect(parseStoredOverrides({ maxFindings: 4 })).toEqual({
      maxFindings: 4,
    });
    expect(parseStoredOverrides({ allowedCommands: "review" })).toEqual({});
    expect(parseStoredOverrides({ allowedCommands: null })).toEqual({});
  });

  it("keeps review switched off when a stored global list only named removed commands", () => {
    const builtIn = builtInReviewSettings("vendor/model");

    const { settings } = resolveReviewSettings({
      builtIn,
      global: parseStoredOverrides({ allowedCommands: ["ask"] }),
    });

    expect(settings.allowedCommands).toEqual([]);
    expect(isCommandAllowed(settings, "review")).toBe(false);
  });

  it("lets a removed-only project list override an inherited review permission", () => {
    const builtIn = builtInReviewSettings("vendor/model");

    const { settings } = resolveReviewSettings({
      builtIn,
      global: { allowedCommands: ["review"] },
      project: parseStoredOverrides({ allowedCommands: ["ask"] }),
    });

    expect(settings.allowedCommands).toEqual([]);
    expect(isCommandAllowed(settings, "review")).toBe(false);
  });

  it("refuses a removed command on a new settings write", () => {
    expect(issuesOf({ allowedCommands: ["ask"] })).toEqual([
      { field: "allowedCommands", code: "INVALID_FORMAT" },
    ]);
  });
});

// The numbers the README, the Jira story and the UI promise, written out: the tests above are
// relative to REVIEW_SETTING_LIMITS, so they would follow a changed constant. These would not.
describe("the documented limits", () => {
  // CR-25-T07, CR-25-T08
  it.each([
    [{ maxTokens: 7_999 }, "maxTokens", "TOO_SMALL"],
    [{ maxTokens: 2_000_001 }, "maxTokens", "TOO_LARGE"],
    [{ maxFindings: 0 }, "maxFindings", "TOO_SMALL"],
    [{ maxFindings: 31 }, "maxFindings", "TOO_LARGE"],
    [{ extraInstructions: "x".repeat(4_001) }, "extraInstructions", "TOO_LONG"],
  ])("refuses %j", (settings, field, code) => {
    expect(issuesOf(settings)).toEqual([{ field, code }]);
  });

  it.each([
    { maxTokens: 8_000 },
    { maxTokens: 2_000_000 },
    { maxFindings: 1 },
    { maxFindings: 30 },
    { extraInstructions: "x".repeat(4_000) },
  ])("accepts %j", (settings) => {
    expect(validateReviewSettingsPatch(settings).ok).toBe(true);
  });

  it("pins the constants to the same numbers", () => {
    expect(REVIEW_SETTING_LIMITS).toEqual({
      extraInstructionsMaxChars: 4_000,
      maxFindings: { min: 1, max: 30 },
      maxTokens: { min: 8_000, max: 2_000_000 },
    });
    expect(PROJECT_DYNAMIC_LIMITS).toEqual({ reviewSkillMaxBytes: 16_384 });
  });
});

// #194-T02, #194-T08: the project-only fields (kind, Dynamic model, skill) with the skill treated as
// untrusted, size-bounded text and stable value-free codes.
describe("validating the project-only settings", () => {
  // #194-T08
  it("accept a valid project-only set and keep the Dynamic model identifier literally", () => {
    expect(
      validateProjectSettingsPatch({
        reviewKind: "dynamic",
        dynamicModel: "vendor/alt-model-2",
        reviewSkill: "Prefer explicit errors.",
      }),
    ).toEqual({
      ok: true,
      value: {
        review: {},
        dynamic: {
          reviewKind: "dynamic",
          dynamicModel: "vendor/alt-model-2",
          reviewSkill: "Prefer explicit errors.",
        },
      },
    });
  });

  it("separate the Diff overrides from the project-only fields", () => {
    expect(
      validateProjectSettingsPatch({ maxFindings: 3, reviewKind: "dynamic" }),
    ).toEqual({
      ok: true,
      value: { review: { maxFindings: 3 }, dynamic: { reviewKind: "dynamic" } },
    });
  });

  // #194-T02
  it("treat an empty or blank skill override as an explicit reset to the shipped default", () => {
    for (const value of ["", "   ", "\n\t "])
      expect(validateProjectSettingsPatch({ reviewSkill: value })).toEqual({
        ok: true,
        value: { review: {}, dynamic: { reviewSkill: null } },
      });
    expect(validateProjectSettingsPatch({ reviewSkill: null })).toEqual({
      ok: true,
      value: { review: {}, dynamic: { reviewSkill: null } },
    });
  });

  // #194-T02: the bounds apply to the raw text, before a blank value is read as a reset.
  it("refuse blank text that holds a forbidden control or is over the byte limit", () => {
    for (const value of ["\u000b", "\u000c", "\u0000 "]) {
      expect(projectIssuesOf({ reviewSkill: value })).toEqual([
        { field: "reviewSkill", code: "FORBIDDEN_CHARACTERS" },
      ]);
    }
    const over = " ".repeat(PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes + 1);
    expect(projectIssuesOf({ reviewSkill: over })).toEqual([
      { field: "reviewSkill", code: "TOO_LONG" },
    ]);
  });

  // #194-T02
  it("accept exactly 16 KiB of multibyte text and refuse one byte more", () => {
    const max = PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes;
    // "ü" is two UTF-8 bytes, so half the limit in characters is exactly the limit in bytes.
    const exact = "ü".repeat(max / 2);
    // One ASCII byte more than the limit, and one more multibyte character too.
    const oneByteOver = `${exact}a`;
    const oneCharacterOver = `${exact}ü`;

    expect(validateProjectSettingsPatch({ reviewSkill: exact })).toEqual({
      ok: true,
      value: { review: {}, dynamic: { reviewSkill: exact } },
    });
    expect(projectIssuesOf({ reviewSkill: oneByteOver })).toEqual([
      { field: "reviewSkill", code: "TOO_LONG" },
    ]);
    expect(projectIssuesOf({ reviewSkill: oneCharacterOver })).toEqual([
      { field: "reviewSkill", code: "TOO_LONG" },
    ]);
  });

  // #194-T02
  it("refuse a skill with control characters or an unpaired surrogate", () => {
    expect(projectIssuesOf({ reviewSkill: "rule\u0000x" })).toEqual([
      { field: "reviewSkill", code: "FORBIDDEN_CHARACTERS" },
    ]);
    expect(projectIssuesOf({ reviewSkill: "rule\ud800x" })).toEqual([
      { field: "reviewSkill", code: "FORBIDDEN_CHARACTERS" },
    ]);
  });

  // #194-T02
  it("refuse an unknown kind and an invalid model with stable codes", () => {
    expect(projectIssuesOf({ reviewKind: "auto" })).toEqual([
      { field: "reviewKind", code: "INVALID_FORMAT" },
    ]);
    expect(projectIssuesOf({ reviewKind: 5 })).toEqual([
      { field: "reviewKind", code: "INVALID_TYPE" },
    ]);
    expect(projectIssuesOf({ dynamicModel: "has space" })).toEqual([
      { field: "dynamicModel", code: "INVALID_FORMAT" },
    ]);
    expect(projectIssuesOf({ dynamicModel: "" })).toEqual([
      { field: "dynamicModel", code: "EMPTY" },
    ]);
  });

  // #405-T28
  it("accept each verdict mode, and null as the reset to the default", () => {
    for (const reviewVerdict of ["off", "blocking", "any", null])
      expect(validateProjectSettingsPatch({ reviewVerdict })).toEqual({
        ok: true,
        value: { review: {}, dynamic: { reviewVerdict } },
      });
  });

  // #405-T28
  it("refuse an unknown verdict mode with a stable code and never echo it", () => {
    expect(projectIssuesOf({ reviewVerdict: "always" })).toEqual([
      { field: "reviewVerdict", code: "INVALID_FORMAT" },
    ]);
    expect(projectIssuesOf({ reviewVerdict: true })).toEqual([
      { field: "reviewVerdict", code: "INVALID_TYPE" },
    ]);
    expect(
      JSON.stringify(projectIssuesOf({ reviewVerdict: "sk-dummy-secret" })),
    ).not.toContain("sk-dummy-secret");
  });

  // #200 review: the model, like the skill, has an explicit `null` reset to the built-in default.
  it("accept a null Dynamic model as the reset to the built-in default", () => {
    expect(validateProjectSettingsPatch({ dynamicModel: null })).toEqual({
      ok: true,
      value: { review: {}, dynamic: { dynamicModel: null } },
    });
  });

  it("only uses stable codes and never echoes a value", () => {
    const secretLooking = "sk-dummy-skill-should-not-be-echoed";
    const issues = projectIssuesOf({
      reviewKind: secretLooking,
      dynamicModel: `${secretLooking} x`,
      reviewSkill: 5,
    });

    for (const issue of issues)
      expect(REVIEW_SETTING_ISSUE_CODES).toContain(issue.code);
    expect(JSON.stringify(issues)).not.toContain(secretLooking);
  });

  // #194-T02: the project-only fields cannot become workspace-wide defaults.
  it("are unknown to the global defaults validation, so they stay project-only", () => {
    expect(issuesOf({ reviewKind: "dynamic" })).toEqual([
      { field: "reviewKind", code: "UNKNOWN_FIELD" },
    ]);
    expect(issuesOf({ dynamicModel: "vendor/model" })).toEqual([
      { field: "dynamicModel", code: "UNKNOWN_FIELD" },
    ]);
    expect(issuesOf({ reviewSkill: "text" })).toEqual([
      { field: "reviewSkill", code: "UNKNOWN_FIELD" },
    ]);
    expect(issuesOf({ reviewVerdict: "any" })).toEqual([
      { field: "reviewVerdict", code: "UNKNOWN_FIELD" },
    ]);
  });

  it("reads stored project-only fields and drops the ones this version would not accept", () => {
    expect(
      parseStoredProjectDynamicOverrides({
        reviewKind: "dynamic",
        dynamicModel: "vendor/alt-model-2",
        reviewSkill: "kept",
        removedField: true,
      }),
    ).toEqual({
      reviewKind: "dynamic",
      dynamicModel: "vendor/alt-model-2",
      reviewSkill: "kept",
    });
    expect(
      parseStoredProjectDynamicOverrides({
        reviewKind: "auto",
        dynamicModel: "x".repeat(300),
        reviewSkill: "rule\u0000x",
      }),
    ).toEqual({});
    expect(parseStoredProjectDynamicOverrides({ reviewSkill: null })).toEqual(
      {},
    );
    // #405-T28: a stored verdict mode is read, one this version does not know is dropped (the default applies).
    expect(
      parseStoredProjectDynamicOverrides({ reviewVerdict: "any" }),
    ).toEqual({ reviewVerdict: "any" });
    expect(
      parseStoredProjectDynamicOverrides({ reviewVerdict: "sometimes" }),
    ).toEqual({});
    expect(parseStoredProjectDynamicOverrides({ reviewVerdict: null })).toEqual(
      {},
    );
    // #200 review: a stored null model is "no override" too, not a stored value.
    expect(
      parseStoredProjectDynamicOverrides({
        reviewKind: "dynamic",
        dynamicModel: null,
      }),
    ).toEqual({ reviewKind: "dynamic" });
  });
});

// #430: the provider and the catalog entry a project selects (ADR 0005, 2.7).
describe("validating the provider and catalog selection", () => {
  // The default provider and a second one that exists only in tests, whose model ids have another shape.
  const twoProviders = createProviderRegistry([
    ...llmProviderDescriptors.providers,
    createFakeAdapter(),
  ]);

  // #430-T01
  it("accepts a provider of the registry as the workspace default and the project, stored by its id", () => {
    expect(validateReviewSettingsPatch({ provider: " OpenRouter " })).toEqual({
      ok: true,
      value: { provider: "openrouter" },
    });
    expect(
      validateProjectSettingsPatch({
        provider: "openrouter",
        dynamicProvider: "openrouter",
      }),
    ).toEqual({
      ok: true,
      value: {
        review: { provider: "openrouter" },
        dynamic: { dynamicProvider: "openrouter" },
      },
    });
  });

  // #430-T01
  it.each([
    [7, "INVALID_TYPE"],
    [null, "INVALID_TYPE"],
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["no-such-provider", "PROVIDER_UNKNOWN"],
    ["openrouter/extra", "PROVIDER_UNKNOWN"],
  ])("refuses the provider %j with %s", (value, code) => {
    expect(issuesOf({ provider: value })).toEqual([
      { field: "provider", code },
    ]);
  });

  // #430-T01
  it("lets a project clear the Dynamic provider with null and refuses anything else that is no provider", () => {
    expect(validateProjectSettingsPatch({ dynamicProvider: null })).toEqual({
      ok: true,
      value: { review: {}, dynamic: { dynamicProvider: null } },
    });
    expect(projectIssuesOf({ dynamicProvider: "nope" })).toEqual([
      { field: "dynamicProvider", code: "PROVIDER_UNKNOWN" },
    ]);
    expect(projectIssuesOf({ dynamicProvider: 3 })).toEqual([
      { field: "dynamicProvider", code: "INVALID_TYPE" },
    ]);
  });

  // #430-T01, #430-T02
  it("keeps the Dynamic provider and the catalog entries out of the workspace defaults", () => {
    for (const field of [
      "dynamicProvider",
      "catalogEntryDiff",
      "catalogEntryDynamic",
    ])
      expect(issuesOf({ [field]: null })).toEqual([
        { field, code: "UNKNOWN_FIELD" },
      ]);
  });

  // #430-T01
  it("accepts a catalog entry id per kind, and null to clear it", () => {
    expect(
      validateProjectSettingsPatch({
        catalogEntryDiff: "mce_0123456789abcdef0123456789abcdef",
        catalogEntryDynamic: null,
      }),
    ).toEqual({
      ok: true,
      value: {
        review: {},
        dynamic: {
          catalogEntryDiff: "mce_0123456789abcdef0123456789abcdef",
          catalogEntryDynamic: null,
        },
      },
    });
  });

  // #430-T01
  it.each([
    [42, "INVALID_TYPE"],
    ["", "EMPTY"],
    ["  ", "EMPTY"],
    ["mce 1; drop", "INVALID_FORMAT"],
    ["Ünicode", "INVALID_FORMAT"],
    ["m".repeat(65), "TOO_LONG"],
  ])(
    "refuses the catalog entry %j with %s, without echoing it",
    (value, code) => {
      const issues = projectIssuesOf({ catalogEntryDynamic: value });

      expect(issues).toEqual([{ field: "catalogEntryDynamic", code }]);
      expect(JSON.stringify(issues)).not.toContain(
        String(value).trim() || "\0",
      );
    },
  );

  // #430-T01
  it("lists the codes of the selection in the stable set", () => {
    expect(REVIEW_SETTING_ISSUE_CODES).toEqual(
      expect.arrayContaining([
        "PROVIDER_UNKNOWN",
        "CATALOG_ENTRY_UNKNOWN",
        "CATALOG_ENTRY_NOT_RELEASED",
        "CATALOG_ENTRY_KIND_MISMATCH",
        "CATALOG_ENTRY_NOT_ALLOWED",
        "CATALOG_ENTRY_OWN_KEY_MODE",
      ]),
    );
  });

  // #430-T01
  it("checks a model against the rule of the provider the same request names", () => {
    // `vendor/model` is a model id of the default provider and none of the second one.
    expect(
      validateReviewSettingsPatch(
        { provider: "fakeai", model: "vendor/model" },
        twoProviders,
      ),
    ).toEqual({
      ok: false,
      issues: [{ field: "model", code: "INVALID_FORMAT" }],
    });
    expect(
      validateReviewSettingsPatch(
        { provider: "fakeai", model: "fake-small" },
        twoProviders,
      ),
    ).toEqual({ ok: true, value: { provider: "fakeai", model: "fake-small" } });
    expect(
      validateProjectSettingsPatch(
        { dynamicProvider: "fakeai", dynamicModel: "vendor/model" },
        twoProviders,
      ),
    ).toEqual({
      ok: false,
      issues: [{ field: "dynamicModel", code: "INVALID_FORMAT" }],
    });
    expect(
      validateReviewSettingsPatch({ model: "vendor/model" }, twoProviders).ok,
    ).toBe(true);
  });

  // #430-T01
  it("does not know a provider the registry lacks", () => {
    expect(validateReviewSettingsPatch({ provider: "fakeai" }).ok).toBe(false);
    expect(
      validateReviewSettingsPatch({ provider: "fakeai" }, twoProviders).ok,
    ).toBe(true);
  });

  // #430-T03
  it("reads the stored selection and drops what this version would not accept", () => {
    expect(parseStoredOverrides({ provider: "openrouter" })).toEqual({
      provider: "openrouter",
    });
    // A provider whose adapter was removed: the default provider applies again.
    expect(parseStoredOverrides({ provider: "removed_provider" })).toEqual({});
    expect(
      parseStoredProjectDynamicOverrides({
        dynamicProvider: "openrouter",
        catalogEntryDiff: "mce_abc",
        catalogEntryDynamic: null,
      }),
    ).toEqual({ dynamicProvider: "openrouter", catalogEntryDiff: "mce_abc" });
    expect(
      parseStoredProjectDynamicOverrides({
        dynamicProvider: "removed_provider",
        catalogEntryDiff: 7,
        catalogEntryDynamic: "not valid!",
      }),
    ).toEqual({});
  });
});
