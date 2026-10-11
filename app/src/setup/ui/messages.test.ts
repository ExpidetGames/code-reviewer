// SPDX-License-Identifier: Apache-2.0

// Pins down the copy of the setup pages: every stable code of the server has a sentence, the
// sentences name what to do (restart the app) where only that helps, and none of them can contain
// a code, a password or any value.
import { describe, expect, it } from "vitest";
import { SETUP_ERROR_CODES } from "../errors.ts";
import {
  describeSetupFailure,
  describeSetupIssue,
  PASSWORD_REASON,
  stepOfField,
} from "./messages.ts";

describe("the sentence for a failed call", () => {
  it("has its own sentence for every code the setup routes answer with a person-facing cause", () => {
    const generic = describeSetupFailure("something_else");
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
      expect(describeSetupFailure(code), code).not.toBe(generic);
  });

  // #97-SU-08
  it("tells the person to restart the app when only a restart helps", () => {
    for (const code of [
      "setup_locked",
      "code_expired",
      "code_used",
      "setup_session_expired",
      "setup_unavailable",
    ])
      expect(describeSetupFailure(code), code).toMatch(/Restart the app/);
  });

  it("explains the lock on a wrong code", () => {
    expect(describeSetupFailure("invalid_code")).toMatch(/10 wrong codes/);
  });

  it("translates the transport codes and falls back to a generic sentence", () => {
    expect(describeSetupFailure("NETWORK_ERROR")).toMatch(
      /could not be reached/,
    );
    expect(describeSetupFailure("anything")).toMatch(/Something went wrong/);
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

  it("states the password rule and its reason", () => {
    expect(PASSWORD_REASON).toMatch(/12/);
    expect(PASSWORD_REASON).toMatch(/128/);
    expect(PASSWORD_REASON).toMatch(/common/);
  });

  it("puts a problem on the step where it can be fixed", () => {
    expect(stepOfField("tenancy")).toBe(1);
    expect(stepOfField("signUp.entries")).toBe(2);
    expect(stepOfField("signUp.kind")).toBe(2);
    expect(stepOfField("admin.password")).toBe(3);
    expect(stepOfField("admin.email")).toBe(3);
  });
});
