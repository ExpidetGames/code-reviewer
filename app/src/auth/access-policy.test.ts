// Pins down the rule that decides, on every authenticated request, whether a signed in user may
// still use the instance: the logins list is checked every time, the organization membership at
// most every 24 hours, and anything that cannot be decided is a no.
import { describe, expect, it, vi } from "vitest";
import { parseAccessConfig } from "./access-config.ts";
import {
  ORG_RECHECK_INTERVAL_MS,
  createAccessPolicy,
  type OrgAccessDependencies,
  type SessionUser,
} from "./access-policy.ts";
import type { OrgMembership } from "./github-org.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user-1",
    name: "The Octocat",
    githubLogin: "octocat",
    orgCheckedAt: null,
    ...overrides,
  };
}

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function setup(
  env: Record<string, string | undefined>,
  membership: OrgMembership | (() => Promise<OrgMembership>) = "member",
) {
  const problems: string[] = [];
  const config = parseAccessConfig(env, problems);
  expect(problems).toEqual([]);
  const org = {
    checkMembership: vi.fn<OrgAccessDependencies["checkMembership"]>(() =>
      typeof membership === "function"
        ? membership()
        : Promise.resolve(membership),
    ),
    recordCheck: vi.fn<OrgAccessDependencies["recordCheck"]>(() =>
      Promise.resolve(),
    ),
    revokeSessions: vi.fn<OrgAccessDependencies["revokeSessions"]>(() =>
      Promise.resolve(),
    ),
  };
  const policy = createAccessPolicy({ config, org, now: () => NOW });
  return { policy, org };
}

describe("the logins list as the access rule of a request", () => {
  // CR-19-T01
  it("allows a listed login without asking GitHub", async () => {
    const { policy, org } = setup({
      ALLOWED_GITHUB_LOGINS: "octocat,hubot",
      ALLOWED_GITHUB_ORG: "my-org",
    });

    expect(await policy(user({ githubLogin: "hubot" }))).toEqual({
      allowed: true,
    });
    expect(org.checkMembership).not.toHaveBeenCalled();
  });

  // CR-19-T02
  it("denies a login that is not listed", async () => {
    const { policy } = setup({ ALLOWED_GITHUB_LOGINS: "octocat,hubot" });

    expect(await policy(user({ githubLogin: "mallory" }))).toEqual({
      allowed: false,
      reason: "not_allowed",
    });
  });

  // CR-19-T04
  it("matches the login without regard to case", async () => {
    const { policy } = setup({ ALLOWED_GITHUB_LOGINS: "OctoCat" });

    expect(await policy(user({ githubLogin: "OCTOCAT" }))).toEqual({
      allowed: true,
    });
  });

  // CR-19-T06
  it("denies logins that merely contain or start with a listed one", async () => {
    const { policy } = setup({ ALLOWED_GITHUB_LOGINS: "octocat" });

    for (const githubLogin of ["octocat2", "cat", "octocat-evil"])
      expect(await policy(user({ githubLogin }))).toEqual({
        allowed: false,
        reason: "not_allowed",
      });
  });

  // CR-19-T03
  it("denies everybody, including an empty login, when nothing is configured", async () => {
    const { policy, org } = setup({
      ALLOWED_GITHUB_LOGINS: " , ",
      ALLOWED_GITHUB_ORG: " ",
    });

    for (const githubLogin of ["octocat", "", " "])
      expect(await policy(user({ githubLogin }))).toEqual({
        allowed: false,
        reason: "not_allowed",
      });
    expect(org.checkMembership).not.toHaveBeenCalled();
  });
});

describe("the organization as the access rule of a request", () => {
  const env = { ALLOWED_GITHUB_ORG: "my-org" };

  it("allows a member checked less than 24 hours ago without asking GitHub again", async () => {
    const { policy, org } = setup(env);

    const decision = await policy(
      user({ orgCheckedAt: ago(ORG_RECHECK_INTERVAL_MS - 1) }),
    );

    expect(decision).toEqual({ allowed: true });
    expect(org.checkMembership).not.toHaveBeenCalled();
  });

  it("asks GitHub again once 24 hours have passed, and remembers a yes", async () => {
    const { policy, org } = setup(env, "member");

    const decision = await policy(
      user({ orgCheckedAt: ago(ORG_RECHECK_INTERVAL_MS) }),
    );

    expect(decision).toEqual({ allowed: true });
    expect(org.checkMembership).toHaveBeenCalledTimes(1);
    expect(org.recordCheck).toHaveBeenCalledWith("user-1", NOW);
  });

  it.each([
    ["never checked", null],
    ["a timestamp that is not a date", "yesterday"],
    [
      "a timestamp in the future",
      new Date(NOW.getTime() + 60_000).toISOString(),
    ],
  ])("asks GitHub when the user was %s", async (_case, orgCheckedAt) => {
    const { policy, org } = setup(env, "member");

    const decision = await policy(user({ orgCheckedAt }));

    expect(decision).toEqual({ allowed: true });
    expect(org.checkMembership).toHaveBeenCalledTimes(1);
  });

  it("denies and signs the person out everywhere once GitHub says they left the organization", async () => {
    const { policy, org } = setup(env, "not_member");

    const decision = await policy(user({ orgCheckedAt: ago(48 * 3600_000) }));

    expect(decision).toEqual({ allowed: false, reason: "not_allowed" });
    expect(org.revokeSessions).toHaveBeenCalledWith("user-1");
    expect(org.recordCheck).not.toHaveBeenCalled();
  });

  it("denies and asks for a new sign in when the stored token is no longer valid", async () => {
    const { policy, org } = setup(env, "token_invalid");

    const decision = await policy(user());

    expect(decision).toEqual({ allowed: false, reason: "sign_in_again" });
    expect(org.revokeSessions).toHaveBeenCalledWith("user-1");
  });

  it("denies without ending the sessions when the check could not be made", async () => {
    const { policy, org } = setup(env, "unavailable");

    const decision = await policy(user());

    expect(decision).toEqual({ allowed: false, reason: "check_failed" });
    expect(org.revokeSessions).not.toHaveBeenCalled();
    expect(org.recordCheck).not.toHaveBeenCalled();
  });

  it("denies when the check itself throws", async () => {
    const { policy } = setup(env, () => Promise.reject(new Error("boom")));

    expect(await policy(user())).toEqual({
      allowed: false,
      reason: "check_failed",
    });
  });

  it("does not lengthen the 24 hours by a check that failed earlier", async () => {
    const { policy, org } = setup(env, "unavailable");

    await policy(user({ orgCheckedAt: ago(ORG_RECHECK_INTERVAL_MS + 1) }));
    await policy(user({ orgCheckedAt: ago(ORG_RECHECK_INTERVAL_MS + 1) }));

    expect(org.checkMembership).toHaveBeenCalledTimes(2);
  });

  it("makes one call to GitHub for requests of the same user that arrive together", async () => {
    let answer: (membership: OrgMembership) => void = () => undefined;
    const { policy, org } = setup(
      env,
      () => new Promise<OrgMembership>((resolve) => (answer = resolve)),
    );

    const first = policy(user());
    const second = policy(user());
    answer("member");

    expect(await first).toEqual({ allowed: true });
    expect(await second).toEqual({ allowed: true });
    expect(org.checkMembership).toHaveBeenCalledTimes(1);
  });

  it("denies a login that is not listed when only the logins list is configured, whatever the timestamp", async () => {
    const { policy, org } = setup({ ALLOWED_GITHUB_LOGINS: "hubot" });

    const decision = await policy(user({ orgCheckedAt: ago(1000) }));

    expect(decision).toEqual({ allowed: false, reason: "not_allowed" });
    expect(org.checkMembership).not.toHaveBeenCalled();
  });
});
