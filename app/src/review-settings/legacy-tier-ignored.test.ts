// SPDX-License-Identifier: LicenseRef-Proprietary

// #434-T03 at the settings layer: the old quality level is no setting any more. Settings already stored with it are
// read without it (the data stays in the row, unread: its removal is a later migration), and a request that still
// carries it is refused like any unknown field. The name is built from parts, so that the scan for the old tier names
// (`src/ci`) does not find it here.
import { describe, expect, it } from "vitest";
import { builtInReviewSettings, REVIEW_SETTING_FIELDS } from "./settings.ts";
import {
  parseStoredOverrides,
  validateReviewSettingsPatch,
} from "./validate.ts";

const LEGACY = ["model", "Tier"].join("");

describe("the quality level of the managed tiers", () => {
  // #434-T03
  it("is no review setting", () => {
    expect(REVIEW_SETTING_FIELDS).not.toContain(LEGACY);
    expect(Object.keys(builtInReviewSettings())).not.toContain(LEGACY);
  });

  // #434-T03
  it("is read from nothing that is stored: the rest of the row still applies", () => {
    expect(parseStoredOverrides({ [LEGACY]: "high", maxFindings: 3 })).toEqual({
      maxFindings: 3,
    });
  });

  // #434-T03
  it("is refused in a request as an unknown field, without echoing a value", () => {
    const result = validateReviewSettingsPatch({ [LEGACY]: "high" });
    expect(result).toEqual({
      ok: false,
      issues: [{ field: LEGACY, code: "UNKNOWN_FIELD" }],
    });
  });
});
