// Pins down the rule that decides, on every authenticated request, whether a signed in user may
// still use the instance: the logins list is checked every time, the organization membership at
// most every 24 hours, and anything that cannot be decided is a no.
import { describe, expect, it, vi } from "vitest";
import { parseAccessConfig } from "./access-config.ts";
import {
  ORG_RECHECK_INTERVAL_MS,
  ORG_UNAVAILABLE_BACKOFF_MS,
  createAccessPolicy,
  type LoginPinDependencies,
  type OrgAccessDependencies,
  type GithubSessionUser,
} from "./access-policy.ts";
import type { OrgMembership } from "./github-org.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function user(overrides: Partial<GithubSessionUser> = {}): GithubSessionUser {
  return {
    id: "user-1",
    name: "The Octocat",
    email: "1001@users.noreply.github.com",
    isInstanceAdmin: false,
    githubLogin: "octocat",
    githubId: "1001",
    orgCheckedAt: null,
    orgCheckedFor: null,
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
  const clock = { now: NOW };
  const logError = vi.fn<(message: string) => void>();
  // The pins: the first id that is offered for a login is the one bound to it.
  const bound = new Map<string, string>();
  const loginPins = {
    pin: vi.fn<LoginPinDependencies["pin"]>((login, githubId) => {
      const key = login.toLowerCase();
      if (!bound.has(key)) bound.set(key, githubId);
      return Promise.resolve(bound.get(key) ?? null);
    }),
    revokeSessions: vi.fn<LoginPinDependencies["revokeSessions"]>(() =>
      Promise.resolve(),
    ),
  };
  const policy = createAccessPolicy({
    config,
    org,
    loginPins,
    now: () => clock.now,
    logError,
  });
  return { policy, org, clock, logError, loginPins, bound };
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
      user({
        orgCheckedAt: ago(ORG_RECHECK_INTERVAL_MS - 1),
        orgCheckedFor: "my-org",
      }),
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
    expect(org.recordCheck).toHaveBeenCalledWith("user-1", NOW, "my-org");
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

  it("does not reuse a confirmation that was made for another organization", async () => {
    const { policy, org } = setup(env, "not_member");

    const decision = await policy(
      user({ orgCheckedAt: ago(1000), orgCheckedFor: "old-org" }),
    );

    expect(decision).toEqual({ allowed: false, reason: "not_allowed" });
    expect(org.checkMembership).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a confirmation without an organization", async () => {
    const { policy, org } = setup(env, "member");

    await policy(user({ orgCheckedAt: ago(1000), orgCheckedFor: null }));

    expect(org.checkMembership).toHaveBeenCalledTimes(1);
  });

  it("compares the organization names without regard to case", async () => {
    const { policy, org } = setup({ ALLOWED_GITHUB_ORG: "My-Org" });

    const decision = await policy(
      user({ orgCheckedAt: ago(1000), orgCheckedFor: "my-org" }),
    );

    expect(decision).toEqual({ allowed: true });
    expect(org.checkMembership).not.toHaveBeenCalled();
  });

  it("does not call GitHub again for 20 seconds after a check that could not be made", async () => {
    const { policy, org, clock } = setup(env, "unavailable");

    await policy(user());
    clock.now = new Date(NOW.getTime() + ORG_UNAVAILABLE_BACKOFF_MS - 1);
    const during = await policy(user());

    expect(during).toEqual({ allowed: false, reason: "check_failed" });
    expect(org.checkMembership).toHaveBeenCalledTimes(1);

    clock.now = new Date(NOW.getTime() + ORG_UNAVAILABLE_BACKOFF_MS);
    await policy(user());
    expect(org.checkMembership).toHaveBeenCalledTimes(2);
  });

  it("keeps the back-off per user and only for checks that could not be made", async () => {
    const { policy, org } = setup(env, "unavailable");

    await policy(user({ id: "user-1" }));
    await policy(user({ id: "user-2" }));
    expect(org.checkMembership).toHaveBeenCalledTimes(2);

    const answered = setup(env, "not_member");
    await answered.policy(user());
    await answered.policy(user());
    expect(answered.org.checkMembership).toHaveBeenCalledTimes(2);
  });

  it("lets a person back in at once after the back-off when GitHub answers again", async () => {
    let membership: OrgMembership = "unavailable";
    const { policy, clock } = setup(env, () => Promise.resolve(membership));
    await policy(user());

    membership = "member";
    clock.now = new Date(NOW.getTime() + ORG_UNAVAILABLE_BACKOFF_MS);

    expect(await policy(user())).toEqual({ allowed: true });
  });

  it("denies with check-failed instead of failing when the check cannot be stored", async () => {
    const { policy, org, logError } = setup(env, "member");
    org.recordCheck.mockRejectedValue(new Error("database is locked"));

    expect(await policy(user())).toEqual({
      allowed: false,
      reason: "check_failed",
    });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).not.toContain("locked");
  });

  it.each([
    ["not_member", "not_allowed"],
    ["token_invalid", "sign_in_again"],
  ] as const)(
    "still denies with %s after trying to end the sessions when that fails",
    async (membership, reason) => {
      const { policy, org, logError } = setup(env, membership);
      org.revokeSessions.mockRejectedValue(new Error("database is locked"));

      expect(await policy(user())).toEqual({ allowed: false, reason });
      expect(org.revokeSessions).toHaveBeenCalledWith("user-1");
      expect(logError).toHaveBeenCalledTimes(1);
    },
  );

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

describe("a listed login that is bound to a GitHub id", () => {
  const list = { ALLOWED_GITHUB_LOGINS: "octocat" };

  // CR-42-T02
  it("is allowed for the account it is bound to, however the login is spelled", async () => {
    const { policy, bound } = setup(list);
    bound.set("octocat", "1001");

    expect(await policy(user({ githubLogin: "OctoCat" }))).toEqual({
      allowed: true,
    });
  });

  // CR-42-T04
  it("is denied for another account with the same login, every time, and its sessions are ended", async () => {
    const { policy, bound, loginPins, org } = setup(list);
    bound.set("octocat", "1001");

    for (let i = 0; i < 3; i += 1)
      expect(await policy(user({ id: "user-2", githubId: "2002" }))).toEqual({
        allowed: false,
        reason: "not_allowed",
      });

    expect(loginPins.revokeSessions).toHaveBeenCalledWith("user-2");
    expect(loginPins.revokeSessions).not.toHaveBeenCalledWith("user-1");
    expect(org.checkMembership).not.toHaveBeenCalled();
    expect(bound.get("octocat")).toBe("1001");
  });

  // CR-42 decision 2
  it("binds the login to the account of a session that has no pin yet, and keeps that binding", async () => {
    const { policy, bound } = setup(list);

    expect(await policy(user({ githubId: "1001" }))).toEqual({ allowed: true });

    expect(bound.get("octocat")).toBe("1001");
    expect(
      await policy(user({ id: "user-2", githubId: "2002" })),
    ).toMatchObject({ allowed: false });
  });

  it("is denied, and nobody is signed out, when the pin cannot be read", async () => {
    const { policy, loginPins } = setup(list);
    loginPins.pin.mockRejectedValue(new Error("locked"));

    expect(await policy(user())).toEqual({
      allowed: false,
      reason: "check_failed",
    });
    expect(loginPins.revokeSessions).not.toHaveBeenCalled();
  });

  it("is denied with not allowed even when ending the sessions fails, and logs it without values", async () => {
    const { policy, bound, loginPins, logError } = setup(list);
    bound.set("octocat", "1001");
    loginPins.revokeSessions.mockRejectedValue(new Error("locked 2002"));

    expect(await policy(user({ githubId: "2002" }))).toEqual({
      allowed: false,
      reason: "not_allowed",
    });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).not.toMatch(
      /2002|1001|octocat/,
    );
  });

  it("is denied with check_failed, without asking the organization or ending sessions, when the pin cannot be read and an organization is set", async () => {
    const { policy, loginPins, org } = setup(
      { ...list, ALLOWED_GITHUB_ORG: "my-org" },
      "member",
    );
    loginPins.pin.mockRejectedValue(new Error("locked"));

    expect(await policy(user())).toEqual({
      allowed: false,
      reason: "check_failed",
    });
    expect(org.checkMembership).not.toHaveBeenCalled();
    expect(org.revokeSessions).not.toHaveBeenCalled();
    expect(loginPins.revokeSessions).not.toHaveBeenCalled();
  });

  // CR-42-T10
  it("is not looked up for a login that is not listed", async () => {
    const { policy, loginPins } = setup(list);

    expect(
      await policy(user({ githubLogin: "mallory", githubId: "666" })),
    ).toEqual({
      allowed: false,
      reason: "not_allowed",
    });
    expect(loginPins.pin).not.toHaveBeenCalled();
  });

  // CR-42-T12
  it("is not looked up in organization mode without a list", async () => {
    const { policy, loginPins } = setup({ ALLOWED_GITHUB_ORG: "my-org" });

    expect(await policy(user())).toEqual({ allowed: true });
    expect(loginPins.pin).not.toHaveBeenCalled();
    expect(loginPins.revokeSessions).not.toHaveBeenCalled();
  });

  // CR-42 decision 5
  it("does not stop an organization member whose id does not match the pin", async () => {
    const { policy, bound, org, loginPins } = setup(
      { ...list, ALLOWED_GITHUB_ORG: "my-org" },
      "member",
    );
    bound.set("octocat", "1001");

    expect(await policy(user({ githubId: "2002" }))).toEqual({ allowed: true });
    expect(org.checkMembership).toHaveBeenCalledTimes(1);
    expect(loginPins.revokeSessions).not.toHaveBeenCalled();
  });

  // CR-42 decision 5
  it("ends the sessions of a wrong-id account that the organization does not know either", async () => {
    const { policy, bound, org } = setup(
      { ...list, ALLOWED_GITHUB_ORG: "my-org" },
      "not_member",
    );
    bound.set("octocat", "1001");

    expect(await policy(user({ githubId: "2002" }))).toEqual({
      allowed: false,
      reason: "not_allowed",
    });
    expect(org.revokeSessions).toHaveBeenCalledWith("user-1");
  });
});
