// SPDX-License-Identifier: Apache-2.0

// Pins down when a sign-up rule is fail-closed (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5): a rule that names emails or domains needs verifiable addresses, that is a mail server
// or GitHub as the only way to sign in.
import { describe, expect, it } from "vitest";
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";
import { signUpRuleState } from "./sign-up-rule-state.ts";

const EMAIL_PASSWORD_ONLY = { emailPassword: true, github: false };
const GITHUB_ONLY = { emailPassword: false, github: true };
const BOTH = { emailPassword: true, github: true };

describe("the state of the sign-up rule", () => {
  // #97-SU-19
  it.each<InstanceSettingValues["sign_up_rule"]>([
    { kind: "emails", entries: ["a@example.com"] },
    { kind: "domains", entries: ["example.com"] },
  ])(
    "is fail-closed for a $kind rule while there is no mail server and sign-in is not GitHub only",
    (rule) => {
      expect(
        signUpRuleState({
          rule,
          mailConfigured: false,
          signInMethods: EMAIL_PASSWORD_ONLY,
        }),
      ).toEqual({ failClosed: true });
      expect(
        signUpRuleState({
          rule,
          mailConfigured: false,
          signInMethods: BOTH,
        }),
      ).toEqual({ failClosed: true });
    },
  );

  it("works for a rule that names domains once a mail server exists", () => {
    expect(
      signUpRuleState({
        rule: { kind: "domains", entries: ["example.com"] },
        mailConfigured: true,
        signInMethods: EMAIL_PASSWORD_ONLY,
      }),
    ).toEqual({ failClosed: false });
  });

  it("works for a rule that names emails when GitHub is the only way to sign in", () => {
    expect(
      signUpRuleState({
        rule: { kind: "emails", entries: ["a@example.com"] },
        mailConfigured: false,
        signInMethods: GITHUB_ONLY,
      }),
    ).toEqual({ failClosed: false });
  });

  it("is never fail-closed for the rule everyone", () => {
    expect(
      signUpRuleState({
        rule: { kind: "everyone" },
        mailConfigured: false,
        signInMethods: EMAIL_PASSWORD_ONLY,
      }),
    ).toEqual({ failClosed: false });
  });
});
