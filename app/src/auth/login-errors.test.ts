// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the text the login page shows for the `error` code that Better Auth puts into the URL
// when a sign in fails: known codes get a specific message, anything else the generic one, and the
// text of the URL never reaches the page.
import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "./login-errors.ts";
import { getProductIdentity } from "../product-identity/current.ts";

const PRODUCT = getProductIdentity();

describe("the message for a failed sign in", () => {
  // CR-18-T10
  it("tells the person that they cancelled when GitHub reports access_denied", () => {
    expect(loginErrorMessage(PRODUCT, "access_denied")).toMatch(/cancel/i);
  });

  // CR-18-T08
  it.each(["state_mismatch", "state_not_found", "please_restart_the_process"])(
    "asks to start over when the sign in cannot be matched to its start (%s)",
    (code) => {
      expect(loginErrorMessage(PRODUCT, code)).toMatch(/start again/i);
    },
  );

  // CR-18-T11
  it.each(["invalid_code", "unable_to_get_user_info", "no_code"])(
    "asks to try again when GitHub did not complete the exchange (%s)",
    (code) => {
      expect(loginErrorMessage(PRODUCT, code)).toMatch(/try again/i);
    },
  );

  it("says that retrying will not help when the account cannot be matched to a user", () => {
    expect(loginErrorMessage(PRODUCT, "account_not_linked")).toMatch(
      /administrator/i,
    );
    expect(loginErrorMessage(PRODUCT, "account_not_linked")).not.toMatch(
      /try again/i,
    );
  });

  // #102-SR-15
  it.each([
    ["github_email_unverified", /verified primary email/i],
    ["email_not_allowed", /not allowed to sign up/i],
    ["signup_closed", /closed/i],
    ["email_exists_unverified", /not verified/i],
    ["github_identity_conflict", /another GitHub account/i],
    ["check_failed", /try again later/i],
    ["github_not_configured", /not set up/i],
  ])(
    "explains the refusal %s of the sign in with GitHub without naming anybody",
    (code, expected) => {
      expect(loginErrorMessage(PRODUCT, code)).toMatch(expected);
    },
  );

  // #97-SU-14
  it("says that the email address or the password is wrong without saying which", () => {
    expect(loginErrorMessage(PRODUCT, "invalid_credentials")).toBe(
      "The email address or the password is not correct.",
    );
  });

  it("uses a generic message for a code it does not know and never echoes it", () => {
    const message = loginErrorMessage(PRODUCT, "<script>alert(1)</script>");

    expect(message).toBe("Sign in failed. Please try again.");
    expect(message).not.toContain("script");
  });

  it("shows nothing when there is no error", () => {
    expect(loginErrorMessage(PRODUCT, undefined)).toBeNull();
    expect(loginErrorMessage(PRODUCT, "")).toBeNull();
  });
});
