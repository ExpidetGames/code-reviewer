// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the copy of the setup pages: every stable code of the server has a sentence, the
// sentences name what to do (make a new code) where only that helps, and none of them can contain
// a code, a password or any value.
import { describe, expect, it } from "vitest";
import { PASSWORD_RULE_HINT } from "../../auth/password-policy.ts";
import { FAIL_CLOSED_WARNING } from "../../signup/ui/rule-copy.ts";
import { SETUP_ERROR_CODES } from "../errors.ts";
import {
  describeSetupFailure,
  describeSetupIssue,
  FAIL_CLOSED_LINE,
  PASSWORD_REASON,
  stepOfField,
} from "./messages.ts";
import { getProductIdentity } from "../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

describe("the sentence for a failed call", () => {
  it("has its own sentence for every code the setup routes answer with a person-facing cause", () => {
    const generic = describeSetupFailure(PRODUCT, "something_else");
    const specific = SETUP_ERROR_CODES.filter(
      (code) =>
        ![
          "invalid_input",
          "unsupported_content_type",
          "body_too_large",
          "not_found",
          "setup_required",
        ].includes(code),
    );

    for (const code of specific)
      expect(describeSetupFailure(PRODUCT, code), code).not.toBe(generic);
  });

  // #97-SU-08
  it("sends the person to pnpm setup-code when only a new code helps", () => {
    for (const code of [
      "setup_locked",
      "code_expired",
      "code_used",
      "setup_session_expired",
      "setup_unavailable",
    ])
      expect(describeSetupFailure(PRODUCT, code), code).toMatch(
        /pnpm setup-code/,
      );
  });

  it("explains the lock on a wrong code", () => {
    expect(describeSetupFailure(PRODUCT, "invalid_code")).toMatch(
      /10 wrong codes/,
    );
  });

  it("translates the transport codes and falls back to a generic sentence", () => {
    expect(describeSetupFailure(PRODUCT, "NETWORK_ERROR")).toMatch(
      /could not be reached/,
    );
    expect(describeSetupFailure(PRODUCT, "anything")).toMatch(
      /Something went wrong/,
    );
  });
});

describe("the sentence for a failed call", () => {
  // #321-T01
  it("sends the person to pnpm setup-code, never to restart the app or read its log", () => {
    for (const code of [
      "invalid_code",
      "setup_locked",
      "code_expired",
      "code_used",
      "setup_session_expired",
      "setup_unavailable",
    ]) {
      const sentence = describeSetupFailure(PRODUCT, code);
      expect(sentence, code).toMatch(/pnpm setup-code/);
      expect(sentence, code).not.toMatch(/Restart|log of the app/);
    }
  });
});

describe("the sentence for a problem with a field", () => {
  // #97-SU-10
  it("shows the reason for each password refusal", () => {
    expect(describeSetupIssue("admin.password", "password_too_short")).toMatch(
      /at least 12/i,
    );
    expect(describeSetupIssue("admin.password", "password_too_long")).toMatch(
      /at most 128/i,
    );
    expect(describeSetupIssue("admin.password", "password_too_common")).toMatch(
      /too common/i,
    );
  });

  it("describes the other field problems", () => {
    expect(describeSetupIssue("admin.email", "email_invalid")).toMatch(
      /valid email/i,
    );
    expect(describeSetupIssue("signUp.entries", "entries_required")).toMatch(
      /at least one/i,
    );
    expect(describeSetupIssue("signUp.entries", "entry_invalid")).toMatch(
      /name@example.com/,
    );
  });

  // #169-T01
  it("states the password rule and its reason", () => {
    expect(PASSWORD_RULE_HINT).toMatch(/at least 12/i);
    expect(PASSWORD_RULE_HINT).toMatch(/at most 128/i);
    expect(PASSWORD_RULE_HINT).toMatch(/not a common password/);
    expect(PASSWORD_REASON).toMatch(/no other rules/i);
  });

  // #172-T04
  it("keeps the fail-closed line to one sentence, the long warning in its shared owner", () => {
    expect(FAIL_CLOSED_LINE.split(".").filter(Boolean)).toHaveLength(1);
    expect(FAIL_CLOSED_LINE).not.toBe(FAIL_CLOSED_WARNING);
    expect(FAIL_CLOSED_WARNING).toMatch(/mail server or GitHub/);
  });

  it("puts a problem on the step where it can be fixed", () => {
    expect(stepOfField("tenancy")).toBe(1);
    expect(stepOfField("signUp.entries")).toBe(2);
    expect(stepOfField("signUp.kind")).toBe(2);
    expect(stepOfField("admin.password")).toBe(3);
    expect(stepOfField("admin.email")).toBe(3);
  });
});
