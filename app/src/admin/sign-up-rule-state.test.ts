// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down when a sign-up rule is fail-closed (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5): a rule that names emails or domains needs verifiable addresses, that is a mail server
// or GitHub as the only way to sign in.
import { describe, expect, it } from "vitest";
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";
import {
  signUpRuleState,
  verificationPathExists,
} from "./sign-up-rule-state.ts";

const EMAIL_PASSWORD_ONLY = { emailPassword: true, github: false };
const GITHUB_ONLY = { emailPassword: false, github: true };
const BOTH = { emailPassword: true, github: true };

describe("the state of the sign-up rule", () => {
  // #97-SU-19
  // #99-SR-22
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

describe("the verification path", () => {
  // #99-SR-05
  it.each([
    ["SMTP present, email with password only", true, EMAIL_PASSWORD_ONLY, true],
    ["SMTP present, GitHub only", true, GITHUB_ONLY, true],
    ["SMTP present, both ways", true, BOTH, true],
    ["no SMTP, GitHub only", false, GITHUB_ONLY, true],
    ["no SMTP, email with password only", false, EMAIL_PASSWORD_ONLY, false],
    ["no SMTP, both ways", false, BOTH, false],
  ])(
    "for %s the answer is %s",
    (_name, mailConfigured, signInMethods, path) => {
      expect(verificationPathExists({ mailConfigured, signInMethods })).toBe(
        path,
      );
    },
  );

  // #99-SR-05
  it("is not needed by the rule everyone, whatever the answer", () => {
    for (const mailConfigured of [true, false])
      for (const signInMethods of [EMAIL_PASSWORD_ONLY, GITHUB_ONLY, BOTH])
        expect(
          signUpRuleState({
            rule: { kind: "everyone" },
            mailConfigured,
            signInMethods,
          }),
        ).toEqual({ failClosed: false });
  });
});
