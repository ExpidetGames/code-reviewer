// SPDX-License-Identifier: Apache-2.0

// Pins down whether an email and password sign-up is open right now, as pure logic: email with password
// has to be on, and a rule that names emails or domains stays closed while the instance cannot verify
// addresses (docs/decisions/0001-editions-setup-and-accounts.md, section 2.5).
import { describe, expect, it } from "vitest";
import type { SignInMethods } from "../admin/sign-in-methods.ts";
import { signUpAvailability } from "./availability.ts";
import type { SignUpRule } from "./rule.ts";

const EMAIL: SignInMethods = { emailPassword: true, github: false };
const GITHUB_ONLY: SignInMethods = { emailPassword: false, github: true };
const BOTH: SignInMethods = { emailPassword: true, github: true };
const EVERYONE: SignUpRule = { kind: "everyone" };
const LIST: SignUpRule = { kind: "emails", entries: ["a@example.com"] };
const DOMAINS: SignUpRule = { kind: "domains", entries: ["example.com"] };

describe("the availability of the email sign-up", () => {
  // #99-SR-08
  it("is open under everyone without a mail server, and nothing is verified by mail", () => {
    expect(
      signUpAvailability({
        rule: EVERYONE,
        mailConfigured: false,
        signInMethods: EMAIL,
      }),
    ).toEqual({ open: true, verifyByMail: false });
  });

  // #99-SR-23
  it("is open under everyone with a mail server, and every address is verified by mail", () => {
    expect(
      signUpAvailability({
        rule: EVERYONE,
        mailConfigured: true,
        signInMethods: BOTH,
      }),
    ).toEqual({ open: true, verifyByMail: true });
  });

  // #99-SR-06
  it.each([LIST, DOMAINS])(
    "is closed for a $kind rule without a mail server (fail-closed)",
    (rule) => {
      expect(
        signUpAvailability({
          rule,
          mailConfigured: false,
          signInMethods: EMAIL,
        }),
      ).toEqual({ open: false, error: "signup_closed" });
      expect(
        signUpAvailability({
          rule,
          mailConfigured: false,
          signInMethods: BOTH,
        }),
      ).toEqual({ open: false, error: "signup_closed" });
    },
  );

  // #99-SR-07
  it.each([LIST, DOMAINS])(
    "opens a $kind rule when a mail server exists, and closes it again when it is removed",
    (rule) => {
      expect(
        signUpAvailability({
          rule,
          mailConfigured: true,
          signInMethods: EMAIL,
        }),
      ).toEqual({ open: true, verifyByMail: true });
      expect(
        signUpAvailability({
          rule,
          mailConfigured: false,
          signInMethods: EMAIL,
        }),
      ).toEqual({ open: false, error: "signup_closed" });
    },
  );

  it("is disabled when email with password is off, whatever the rule", () => {
    for (const rule of [EVERYONE, LIST, DOMAINS])
      for (const mailConfigured of [true, false])
        expect(
          signUpAvailability({
            rule,
            mailConfigured,
            signInMethods: GITHUB_ONLY,
          }),
        ).toEqual({ open: false, error: "sign_up_disabled" });
  });
});
