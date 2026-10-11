// SPDX-License-Identifier: Apache-2.0

// Pins down the sign-up rule as pure logic (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5): which addresses a rule lets in, how an address is read, and that anything that is not
// a clear yes is a no. No database and no request: the sign-up, the invitations and the GitHub sign-in
// all call this one function.
import { describe, expect, it } from "vitest";
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";
import { canonicalEmail, evaluateSignUpRule } from "./rule.ts";

type Rule = InstanceSettingValues["sign_up_rule"];
const EVERYONE: Rule = { kind: "everyone" };
const emails = (...entries: string[]): Rule => ({ kind: "emails", entries });
const domains = (...entries: string[]): Rule => ({ kind: "domains", entries });

describe("the sign-up rule everyone", () => {
  // #99-SR-01
  it.each(["a@example.com", "Some.One@Sub.Example.org", "x+tag@example.io"])(
    "allows the well-formed address %s",
    (address) => {
      expect(evaluateSignUpRule(EVERYONE, address)).toEqual({
        ok: true,
        email: address.toLowerCase(),
      });
    },
  );
});

describe("an address that is reserved for GitHub placeholders", () => {
  // #99-SR-09
  it("is refused under every rule, so nobody can take the placeholder address of a GitHub user", () => {
    const address = "583231@users.noreply.github.com";

    for (const rule of [
      EVERYONE,
      emails(address),
      domains("users.noreply.github.com"),
    ])
      expect(evaluateSignUpRule(rule, address)).toEqual({
        ok: false,
        error: "email_not_allowed",
      });
  });

  it("does not keep out other addresses at github.com", () => {
    expect(evaluateSignUpRule(EVERYONE, "someone@github.com").ok).toBe(true);
  });
});

describe("a rule that lists email addresses", () => {
  const rule = emails("alice@example.com");

  // #99-SR-02
  it("ignores case and surrounding white space", () => {
    expect(evaluateSignUpRule(rule, "Alice@Example.com")).toEqual({
      ok: true,
      email: "alice@example.com",
    });
    expect(evaluateSignUpRule(rule, " alice@example.com ")).toEqual({
      ok: true,
      email: "alice@example.com",
    });
  });

  // #99-SR-02
  it("does not strip a plus tag, so a plus address is a different address", () => {
    expect(evaluateSignUpRule(rule, "alice+x@example.com")).toEqual({
      ok: false,
      error: "email_not_allowed",
    });
  });

  it("refuses an address that is not listed", () => {
    expect(evaluateSignUpRule(rule, "bob@example.com")).toEqual({
      ok: false,
      error: "email_not_allowed",
    });
  });

  // #99-SR-04
  it("lets nobody in when the list is empty", () => {
    expect(evaluateSignUpRule(emails(), "alice@example.com")).toEqual({
      ok: false,
      error: "email_not_allowed",
    });
    expect(evaluateSignUpRule(domains(), "alice@example.com")).toEqual({
      ok: false,
      error: "email_not_allowed",
    });
  });
});

describe("a rule that lists domains", () => {
  const rule = domains("example.com");

  // #99-SR-03
  it.each([
    ["a@example.com", true],
    ["a@EXAMPLE.com", true],
    ["a@sub.example.com", false],
    ["a@example.com.evil.org", false],
    ["a@evilexample.com", false],
    ["a@xexample.com", false],
  ])("for %s the answer is %s", (address, allowed) => {
    expect(evaluateSignUpRule(rule, address).ok).toBe(allowed);
  });

  it("accepts a plus address of an allowed domain", () => {
    expect(evaluateSignUpRule(rule, "a+b@example.com").ok).toBe(true);
  });

  // #99-SR-04
  it("compares an internationalized domain in its punycode form", () => {
    const idn = domains("xn--bcher-kva.example");

    expect(evaluateSignUpRule(idn, "a@bücher.example")).toEqual({
      ok: true,
      email: "a@xn--bcher-kva.example",
    });
    expect(evaluateSignUpRule(idn, "a@xn--bcher-kva.example").ok).toBe(true);
    expect(evaluateSignUpRule(idn, "a@buecher.example").ok).toBe(false);
  });
});

describe("reading an address", () => {
  // #99-SR-04
  it.each([
    "a@",
    "@b.com",
    "a b@example.com",
    "a@b@example.com",
    "",
    "   ",
    "plain",
    "a@localhost",
    "a@example.com.",
    "a@-bad.example.com",
    `${"x".repeat(250)}@example.com`,
  ])("refuses the malformed address %j with invalid_email", (address) => {
    expect(evaluateSignUpRule(EVERYONE, address)).toEqual({
      ok: false,
      error: "invalid_email",
    });
    expect(canonicalEmail(address)).toBeNull();
  });

  it("refuses a value that is not text", () => {
    for (const value of [undefined, null, 5, {}, ["a@example.com"]])
      expect(evaluateSignUpRule(EVERYONE, value)).toEqual({
        ok: false,
        error: "invalid_email",
      });
  });

  it("answers invalid_email, not email_not_allowed, for a malformed address under a list", () => {
    expect(evaluateSignUpRule(emails("a@example.com"), "a@")).toEqual({
      ok: false,
      error: "invalid_email",
    });
  });
});
