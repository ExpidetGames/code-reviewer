// SPDX-License-Identifier: LicenseRef-Proprietary

// #689-T04 at the settings layer: the token budget is no setting any more. Settings already stored with it are read without
// it (the data stays in the row, unread: no migration), and a request that still carries it is refused like any unknown
// field, as the quality level of the managed tiers was (#434, `legacy-tier-ignored.test.ts`).
import { describe, expect, it } from "vitest";
import {
  builtInReviewSettings,
  REVIEW_SETTING_FIELDS,
  REVIEW_SETTING_LIMITS,
} from "./settings.ts";
import {
  parseStoredOverrides,
  REVIEW_SETTING_ISSUE_CODES,
  validateProjectSettingsPatch,
  validateReviewSettingsPatch,
  validateWorkspaceSettingsPatch,
} from "./validate.ts";

const REMOVED = "maxTokens";

describe("the token budget of a review", () => {
  // #689-T04
  it("is no review setting, and has no limits or built-in value", () => {
    expect(REVIEW_SETTING_FIELDS).not.toContain(REMOVED);
    expect(Object.keys(builtInReviewSettings())).not.toContain(REMOVED);
    expect(Object.keys(REVIEW_SETTING_LIMITS)).not.toContain(REMOVED);
  });

  // #689-T04
  it("has no issue code of its own left", () => {
    expect(REVIEW_SETTING_ISSUE_CODES).not.toContain("EXCEEDS_MODEL_CONTEXT");
  });

  // #689-T04
  it("is read from nothing that is stored: the rest of the row still applies", () => {
    expect(
      parseStoredOverrides({ [REMOVED]: 150_000, maxFindings: 3 }),
    ).toEqual({ maxFindings: 3 });
  });

  // #689-T04
  it.each([
    ["the global patch", validateReviewSettingsPatch],
    ["a project save", validateProjectSettingsPatch],
    ["a save of the workspace defaults", validateWorkspaceSettingsPatch],
  ])(
    "is refused by %s as an unknown field, without echoing a value",
    (_, validate) => {
      expect(validate({ [REMOVED]: 150_000 })).toEqual({
        ok: false,
        issues: [{ field: REMOVED, code: "UNKNOWN_FIELD" }],
      });
    },
  );
});
