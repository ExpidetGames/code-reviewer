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
    ["http:", "http://billing.example/plans", "url_not_https"],
    ["a scheme that is no web page", "javascript:alert(1)", "url_not_https"],
    ["ftp:", "ftp://billing.example/", "url_not_https"],
    [
      "credentials",
      "https://user:pw@billing.example/plans",
      "url_has_credentials",
    ],
    [
      "a user name alone",
      "https://user@billing.example/plans",
      "url_has_credentials",
    ],
    ["a fragment", "https://billing.example/plans#top", "url_has_fragment"],
    ["an empty fragment", "https://billing.example/plans#", "url_has_fragment"],
    ["a relative path", "/plans", "url_invalid"],
    ["a scheme-relative address", "//billing.example/plans", "url_invalid"],
    ["no scheme", "billing.example/plans", "url_invalid"],
    ["a scheme without slashes", "https:billing.example", "url_invalid"],
    ["a backslash", "https:\\\\billing.example", "url_invalid"],
    ["white space inside", "https://billing.example/a b", "url_invalid"],
    ["a line break", "https://billing.example/\nplans", "url_invalid"],
    ["nothing", "", "url_invalid"],
    ["only white space", "   ", "url_invalid"],
    ["not a string", 42, "url_invalid"],
    ["null", null, "url_invalid"],
    [
      "more than the allowed length",
      `https://billing.example/${"a".repeat(MAX_PLAN_MANAGEMENT_URL_LENGTH)}`,
      "url_too_long",
    ],
  ])("refuses %s", (_name, input, code) => {
    expect(checkPlanManagementUrl(input)).toEqual({ ok: false, code });
  });

  it("accepts an absolute https address and stores it in its normal form", () => {
    expect(checkPlanManagementUrl("https://billing.example")).toEqual({
      ok: true,
      url: "https://billing.example/",
    });
    expect(
      checkPlanManagementUrl("  HTTPS://Billing.Example:8443/plans?x=1  "),
    ).toEqual({ ok: true, url: "https://billing.example:8443/plans?x=1" });
  });
});

describe("the address a person is handed over to", () => {
  // #284-T02
  it("is the configured address with the token as the one handoff parameter", () => {
    expect(handoffLocation("https://billing.example/plans", "tok")).toBe(
      "https://billing.example/plans?handoff=tok",
    );
  });

  it("keeps the other parameters and replaces a handoff parameter that was configured", () => {
    expect(
      handoffLocation("https://billing.example/plans?x=1&handoff=old", "tok"),
    ).toBe("https://billing.example/plans?x=1&handoff=tok");
  });
});
