// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the sign-up rules for a GitHub sign-in as pure logic: the rule is applied to the verified
// primary email only, a missing or unverified one is refused, a fail-closed rule refuses everybody, and a
// GitHub identity links to an existing account only when both addresses are verified.
import { describe, expect, it } from "vitest";
import {
  decideGithubLink,
  decideGithubSignUp,
  verifiedPrimaryEmail,
} from "./github.ts";

describe("the verified primary email of a GitHub account", () => {
  // #99-SR-15
  it("is the primary address when GitHub says it is verified", () => {
    expect(
      verifiedPrimaryEmail([
        { email: "other@example.com", primary: false, verified: true },
        { email: "Main@Example.com", primary: true, verified: true },
      ]),
    ).toBe("main@example.com");
  });

  // #99-SR-16
  it.each([
    [
      "is unverified",
      [{ email: "a@example.com", primary: true, verified: false }],
    ],
    ["is missing", []],
    [
      "is not marked primary",
      [{ email: "a@example.com", primary: false, verified: true }],
    ],
    [
      "is not an address",
      [{ email: "not an address", primary: true, verified: true }],
    ],
  ])("is nothing when the primary address %s", (_name, emails) => {
    expect(verifiedPrimaryEmail(emails)).toBeNull();
  });
});

describe("a new GitHub account", () => {
  const LIST = { kind: "emails", entries: ["alice@example.com"] } as const;
  const rule = { kind: "emails" as const, entries: [...LIST.entries] };

  // #99-SR-15
  it("is created when the verified primary email is on the list", () => {
    expect(
      decideGithubSignUp({
        rule,
        failClosed: false,
        primaryEmail: "alice@example.com",
      }),
    ).toEqual({ ok: true, email: "alice@example.com" });
  });

  // #99-SR-16
  it("is refused when GitHub reports no verified primary email, under any rule", () => {
    for (const r of [{ kind: "everyone" as const }, rule])
      expect(
        decideGithubSignUp({ rule: r, failClosed: false, primaryEmail: null }),
      ).toEqual({
        ok: false,
        error: "github_email_unverified",
      });
  });

  // #99-SR-16
  it("is refused when the verified email is not on the list", () => {
    expect(
      decideGithubSignUp({
        rule,
        failClosed: false,
        primaryEmail: "bob@example.com",
      }),
    ).toEqual({ ok: false, error: "email_not_allowed" });
  });

  // #99-SR-06
  it("is refused while the rule is fail-closed, even for a listed address", () => {
    expect(
      decideGithubSignUp({
        rule,
        failClosed: true,
        primaryEmail: "alice@example.com",
      }),
    ).toEqual({ ok: false, error: "signup_closed" });
  });

  it("is created under the rule everyone for any verified email", () => {
    expect(
      decideGithubSignUp({
        rule: { kind: "everyone" },
        failClosed: false,
        primaryEmail: "anyone@example.org",
      }),
    ).toEqual({ ok: true, email: "anyone@example.org" });
  });
});

describe("linking a GitHub identity to an existing account", () => {
  // #99-SR-26
  it("links when both addresses are verified", () => {
    expect(decideGithubLink({ emailVerified: true })).toEqual({
      action: "link",
    });
  });

  // #99-SR-26
  it("refuses with email_exists_unverified when the account's address is not verified", () => {
    expect(decideGithubLink({ emailVerified: false })).toEqual({
      action: "refuse",
      error: "email_exists_unverified",
    });
  });

  it("creates a new account when no account has the address", () => {
    expect(decideGithubLink(null)).toEqual({ action: "create" });
  });
});
