// Pins down who is let in when the OAuth callback is completed: a listed login at once, otherwise
// a member of the organization (asked with the token that was just issued), and every doubt is a no.
import { describe, expect, it, vi } from "vitest";
import { parseAccessConfig } from "./access-config.ts";
import type { OrgMembership } from "./github-org.ts";
import type { LoginPins } from "./login-pins.ts";
import { decideSignIn, readSignInAccess } from "./sign-in-access.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function decide(
  env: Record<string, string | undefined>,
  login: string,
  membership: OrgMembership | "throws" = "member",
  pinned: string | null | "throws" = "1001",
  githubId = "1001",
) {
  const config = parseAccessConfig(env, []);
  const pins: LoginPins = {
    pin: vi.fn(() =>
      pinned === "throws"
        ? Promise.reject(new Error("locked"))
        : Promise.resolve(pinned),
    ),
  };
  const checkMembership = vi.fn(() =>
    membership === "throws"
      ? Promise.reject(new Error("boom"))
      : Promise.resolve(membership),
  );
  const result = decideSignIn({
    config,
    login,
    githubId,
    pins,
    checkMembership,
    now: () => NOW,
  });
  return { result, checkMembership, pins };
}

describe("the sign in decision", () => {
  // CR-19-T01
  it("lets a listed login in without asking GitHub about the organization", async () => {
    const { result, checkMembership } = decide(
      { ALLOWED_GITHUB_LOGINS: "octocat", ALLOWED_GITHUB_ORG: "my-org" },
      "OctoCat",
    );

    expect(await result).toEqual({ allowed: true, orgCheck: null });
    expect(checkMembership).not.toHaveBeenCalled();
  });

  // CR-19-T02
  it("keeps an unlisted login out when there is no organization", async () => {
    const { result, checkMembership } = decide(
      { ALLOWED_GITHUB_LOGINS: "octocat" },
      "mallory",
    );

    expect(await result).toEqual({ allowed: false, reason: "not_allowed" });
    expect(checkMembership).not.toHaveBeenCalled();
  });

  // CR-19-T03
  it("keeps everybody out when nothing is configured", async () => {
    const { result } = decide({}, "octocat");

    expect(await result).toEqual({ allowed: false, reason: "not_allowed" });
  });

  // CR-19-T09
  it("lets a member of the organization in and notes the time of the check", async () => {
    const { result, checkMembership } = decide(
      { ALLOWED_GITHUB_ORG: "my-org" },
      "octocat",
      "member",
    );

    expect(await result).toEqual({
      allowed: true,
      orgCheck: { at: NOW.toISOString(), org: "my-org" },
    });
    expect(checkMembership).toHaveBeenCalledTimes(1);
  });

  // CR-19-T10
  it("keeps a non-member out with the plain message", async () => {
    const { result } = decide(
      { ALLOWED_GITHUB_ORG: "my-org" },
      "octocat",
      "not_member",
    );

    expect(await result).toEqual({ allowed: false, reason: "not_allowed" });
  });

  // CR-19-T11
  it.each(["unavailable", "token_invalid", "throws"] as const)(
    "keeps a person out with a check-failed message when the answer is %s",
    async (membership) => {
      const { result } = decide(
        { ALLOWED_GITHUB_ORG: "my-org" },
        "octocat",
        membership,
      );

      expect(await result).toEqual({ allowed: false, reason: "check_failed" });
    },
  );
});

describe("the sign in decision for a listed login that is bound to a GitHub id", () => {
  const list = { ALLOWED_GITHUB_LOGINS: "octocat" };

  // CR-42-T01
  it("lets the bound account in", async () => {
    const { result, pins } = decide(list, "octocat", "member", "1001", "1001");

    expect(await result).toEqual({ allowed: true, orgCheck: null });
    expect(pins.pin).toHaveBeenCalledWith("octocat", "1001");
  });

  // CR-42-T03
  it("keeps out another account with the same login, with the plain message", async () => {
    const { result } = decide(list, "octocat", "member", "1001", "2002");

    expect(await result).toEqual({ allowed: false, reason: "not_allowed" });
  });

  it("keeps everybody out when the pin cannot be read or written", async () => {
    for (const pinned of [null, "throws"] as const) {
      const { result } = decide(list, "octocat", "member", pinned);

      expect(await result).toEqual({ allowed: false, reason: "check_failed" });
    }
  });

  // CR-42-T10
  it("does not touch the pins for a login that is not listed", async () => {
    const { result, pins } = decide(list, "mallory", "member", "1001", "666");

    expect(await result).toEqual({ allowed: false, reason: "not_allowed" });
    expect(pins.pin).not.toHaveBeenCalled();
  });

  // CR-42-T12
  it("does not touch the pins in organization mode without a list", async () => {
    const { result, pins } = decide(
      { ALLOWED_GITHUB_ORG: "my-org" },
      "octocat",
    );

    expect(await result).toEqual({
      allowed: true,
      orgCheck: { at: NOW.toISOString(), org: "my-org" },
    });
    expect(pins.pin).not.toHaveBeenCalled();
  });

  // CR-42 decision 5
  it("still lets an organization member in whose id does not match the pin", async () => {
    const { result, checkMembership } = decide(
      { ALLOWED_GITHUB_LOGINS: "octocat", ALLOWED_GITHUB_ORG: "my-org" },
      "octocat",
      "member",
      "1001",
      "2002",
    );

    expect(await result).toEqual({
      allowed: true,
      orgCheck: { at: NOW.toISOString(), org: "my-org" },
    });
    expect(checkMembership).toHaveBeenCalledTimes(1);
  });

  // CR-42 decision 5
  it("keeps out an account with the wrong id who is not in the organization either", async () => {
    const { result } = decide(
      { ALLOWED_GITHUB_LOGINS: "octocat", ALLOWED_GITHUB_ORG: "my-org" },
      "octocat",
      "not_member",
      "1001",
      "2002",
    );

    expect(await result).toEqual({ allowed: false, reason: "not_allowed" });
  });
});

describe("reading the decision back from the profile", () => {
  it("returns a decision that was attached by the provider", () => {
    expect(
      readSignInAccess({
        codeReviewerAccess: {
          allowed: true,
          orgCheck: { at: "2026-10-10", org: "my-org" },
        },
      }),
    ).toEqual({
      allowed: true,
      orgCheck: { at: "2026-10-10", org: "my-org" },
    });
    expect(
      readSignInAccess({
        codeReviewerAccess: { allowed: false, reason: "check_failed" },
      }),
    ).toEqual({ allowed: false, reason: "check_failed" });
  });

  it.each([
    ["no profile", undefined],
    ["no decision", {}],
    ["a decision that is not an object", { codeReviewerAccess: true }],
    ["a null decision", { codeReviewerAccess: null }],
    [
      "a truthy but not boolean allowed",
      { codeReviewerAccess: { allowed: "yes" } },
    ],
  ])("counts %s as not allowed", (_case, profile) => {
    expect(readSignInAccess(profile)).toEqual({
      allowed: false,
      reason: "not_allowed",
    });
  });
});
