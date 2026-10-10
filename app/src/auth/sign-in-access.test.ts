// Pins down who is let in when the OAuth callback is completed: a listed login at once, otherwise
// a member of the organization (asked with the token that was just issued), and every doubt is a no.
import { describe, expect, it, vi } from "vitest";
import { parseAccessConfig } from "./access-config.ts";
import type { OrgMembership } from "./github-org.ts";
import { decideSignIn, readSignInAccess } from "./sign-in-access.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function decide(
  env: Record<string, string | undefined>,
  login: string,
  membership: OrgMembership | "throws" = "member",
) {
  const config = parseAccessConfig(env, []);
  const checkMembership = vi.fn(() =>
    membership === "throws"
      ? Promise.reject(new Error("boom"))
      : Promise.resolve(membership),
  );
  const result = decideSignIn({
    config,
    login,
    checkMembership,
    now: () => NOW,
  });
  return { result, checkMembership };
}

describe("the sign in decision", () => {
  // CR-19-T01
  it("lets a listed login in without asking GitHub about the organization", async () => {
    const { result, checkMembership } = decide(
      { ALLOWED_GITHUB_LOGINS: "octocat", ALLOWED_GITHUB_ORG: "my-org" },
      "OctoCat",
    );

    expect(await result).toEqual({ allowed: true, orgCheckedAt: null });
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
      orgCheckedAt: NOW.toISOString(),
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

describe("reading the decision back from the profile", () => {
  it("returns a decision that was attached by the provider", () => {
    expect(
      readSignInAccess({
        codeReviewerAccess: { allowed: true, orgCheckedAt: "2026-10-10" },
      }),
    ).toEqual({ allowed: true, orgCheckedAt: "2026-10-10" });
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
