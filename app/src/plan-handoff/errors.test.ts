// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  PLAN_HANDOFF_ERROR_CODES,
  planHandoffErrorOf,
  settingsPathWithPlanError,
} from "./errors.ts";

describe("the refusal codes of a click on Manage plan", () => {
  // #284-P3
  it.each(PLAN_HANDOFF_ERROR_CODES)(
    "reads %s from the address of the settings page",
    (code) => {
      expect(planHandoffErrorOf(code)).toBe(code);
    },
  );

  // #284-P3
  it.each([
    undefined,
    ["rate_limited", "cross_site_request"],
    "",
    "RATE_LIMITED",
    "<script>",
    "unknown",
    "constructor",
  ])(
    "takes %j for no refusal, so the page never shows what it does not know",
    (value) => {
      expect(planHandoffErrorOf(value)).toBeNull();
    },
  );

  // #284-P3
  it("builds a relative path below the workspace, with the code as the one parameter", () => {
    expect(settingsPathWithPlanError("acme", "rate_limited")).toBe(
      "/w/acme/settings?plan_error=rate_limited",
    );
    expect(settingsPathWithPlanError("a/../b", "rate_limited")).toBe(
      "/w/a%2F..%2Fb/settings?plan_error=rate_limited",
    );
  });
});
