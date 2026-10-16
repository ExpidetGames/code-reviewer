// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  checkPlanManagementUrl,
  handoffLocation,
  MAX_PLAN_MANAGEMENT_URL_LENGTH,
} from "./url.ts";

describe("the address of the operator-configured plan page", () => {
  // #284-T11
  it.each([
    ["http:", "http://plans.example/plans", "url_not_https"],
    ["a scheme that is no web page", "javascript:alert(1)", "url_not_https"],
    ["ftp:", "ftp://plans.example/", "url_not_https"],
    [
      "credentials",
      "https://user:pw@plans.example/plans",
      "url_has_credentials",
    ],
    [
      "a user name alone",
      "https://user@plans.example/plans",
      "url_has_credentials",
    ],
    ["a fragment", "https://plans.example/plans#top", "url_has_fragment"],
    ["an empty fragment", "https://plans.example/plans#", "url_has_fragment"],
    ["a relative path", "/plans", "url_invalid"],
    ["a scheme-relative address", "//plans.example/plans", "url_invalid"],
    ["no scheme", "plans.example/plans", "url_invalid"],
    ["a scheme without slashes", "https:plans.example", "url_invalid"],
    ["a backslash", "https:\\\\plans.example", "url_invalid"],
    ["white space inside", "https://plans.example/a b", "url_invalid"],
    ["a line break", "https://plans.example/\nplans", "url_invalid"],
    ["nothing", "", "url_invalid"],
    ["only white space", "   ", "url_invalid"],
    ["not a string", 42, "url_invalid"],
    ["null", null, "url_invalid"],
    [
      "more than the allowed length",
      `https://plans.example/${"a".repeat(MAX_PLAN_MANAGEMENT_URL_LENGTH)}`,
      "url_too_long",
    ],
  ])("refuses %s", (_name, input, code) => {
    expect(checkPlanManagementUrl(input)).toEqual({ ok: false, code });
  });

  it("accepts an absolute https address and stores it in its normal form", () => {
    expect(checkPlanManagementUrl("https://plans.example")).toEqual({
      ok: true,
      url: "https://plans.example/",
    });
    expect(
      checkPlanManagementUrl("  HTTPS://Billing.Example:8443/plans?x=1  "),
    ).toEqual({ ok: true, url: "https://plans.example:8443/plans?x=1" });
  });
});

describe("the address a person is handed over to", () => {
  // #284-T02
  it("is the configured address with the token as the one handoff parameter", () => {
    expect(handoffLocation("https://plans.example/plans", "tok")).toBe(
      "https://plans.example/plans?handoff=tok",
    );
  });

  it("keeps the other parameters and replaces a handoff parameter that was configured", () => {
    expect(
      handoffLocation("https://plans.example/plans?x=1&handoff=old", "tok"),
    ).toBe("https://plans.example/plans?x=1&handoff=tok");
  });
});
