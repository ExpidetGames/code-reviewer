// SPDX-License-Identifier: Apache-2.0

// Who becomes a member when an existing installation is imported: the rules of the earlier allow list, applied once,
// with the organization check as a function the test gives. Pure logic, no database and no network.
import { describe, expect, it } from "vitest";
import { parseAccessConfig } from "../auth/access-config.ts";
import type { LegacyUser } from "../db/repositories/legacy-users-repository.ts";
import { decideMembers, pickOwner, type OrgCheckOutcome } from "./members.ts";

function user(login: string, githubId: number, day: number): LegacyUser {
  return {
    id: `user-${login}`,
    githubLogin: login,
    githubId: String(githubId),
    accessToken: `token-${login}`,
    hasPassword: false,
    createdAt: `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    importedAt: null,
  };
}

const NO_ORGANIZATION = async (): Promise<OrgCheckOutcome> => "unavailable";

describe("deciding who becomes a member", () => {
  // #106-IM-03
  it("admits the listed logins whose binding matches, whatever the spelling", async () => {
    const users = [user("Alice", 1, 1), user("bob", 2, 2)];

    const decisions = await decideMembers({
      users,
      config: parseAccessConfig({ ALLOWED_GITHUB_LOGINS: "alice, BOB" }, []),
      pins: new Map([["alice", "1"]]),
      checkOrganization: NO_ORGANIZATION,
    });

    expect(decisions).toEqual([
      { userId: "user-Alice", allowed: true, via: "login" },
      { userId: "user-bob", allowed: true, via: "login" },
    ]);
  });

  // #106-IM-04
  it("does not admit an account whose login is bound to another id", async () => {
    const decisions = await decideMembers({
      users: [user("alice", 5, 1)],
      config: parseAccessConfig({ ALLOWED_GITHUB_LOGINS: "alice" }, []),
      pins: new Map([["alice", "1"]]),
      checkOrganization: NO_ORGANIZATION,
    });

    expect(decisions).toEqual([
      {
        userId: "user-alice",
        allowed: false,
        reason: "login_bound_to_another_account",
      },
    ]);
  });

  // #106-IM-04
  it("lets an id given as login:id win over the stored binding", async () => {
    const decisions = await decideMembers({
      users: [
        user("alice", 1, 1),
        { ...user("alice", 9, 2), id: "user-alice-2" },
      ],
      config: parseAccessConfig({ ALLOWED_GITHUB_LOGINS: "alice:9" }, []),
      pins: new Map([["alice", "1"]]),
      checkOrganization: NO_ORGANIZATION,
    });

    expect(decisions.map((d) => d.allowed)).toEqual([false, true]);
  });

  // #106-IM-04
  it("admits neither of two accounts that hold the same unbound login, and says so for both", async () => {
    const decisions = await decideMembers({
      users: [
        user("alice", 1, 1),
        { ...user("alice", 2, 2), id: "user-alice-2" },
      ],
      config: parseAccessConfig({ ALLOWED_GITHUB_LOGINS: "alice" }, []),
      pins: new Map(),
      checkOrganization: NO_ORGANIZATION,
    });

    expect(decisions).toEqual([
      { userId: "user-alice", allowed: false, reason: "login_ambiguous" },
      { userId: "user-alice-2", allowed: false, reason: "login_ambiguous" },
    ]);
  });

  // #106-IM-04
  it("admits the account a pinned login belongs to when a second account holds the name", async () => {
    const decisions = await decideMembers({
      users: [
        user("alice", 1, 1),
        { ...user("alice", 2, 2), id: "user-alice-2" },
      ],
      config: parseAccessConfig({ ALLOWED_GITHUB_LOGINS: "alice" }, []),
      pins: new Map([["alice", "2"]]),
      checkOrganization: NO_ORGANIZATION,
    });

    expect(decisions.map((d) => d.allowed)).toEqual([false, true]);
  });

  // #106-IM-04
  it("lets the organization admit an account whose login is ambiguous", async () => {
    const decisions = await decideMembers({
      users: [
        user("alice", 1, 1),
        { ...user("alice", 2, 2), id: "user-alice-2" },
      ],
      config: parseAccessConfig(
        { ALLOWED_GITHUB_LOGINS: "alice", ALLOWED_GITHUB_ORG: "acme" },
        [],
      ),
      pins: new Map(),
      checkOrganization: async (u) =>
        u.githubId === "2" ? "member" : "not_member",
    });

    expect(decisions).toEqual([
      { userId: "user-alice", allowed: false, reason: "login_ambiguous" },
      { userId: "user-alice-2", allowed: true, via: "organization" },
    ]);
  });

  // #106-IM-05
  it("asks the organization only for users the list did not admit, and admits a member", async () => {
    const asked: string[] = [];

    const decisions = await decideMembers({
      users: [user("alice", 1, 1), user("bob", 2, 2), user("carol", 3, 3)],
      config: parseAccessConfig(
        { ALLOWED_GITHUB_LOGINS: "alice", ALLOWED_GITHUB_ORG: "acme" },
        [],
      ),
      pins: new Map(),
      checkOrganization: async (u) => {
        asked.push(u.githubLogin ?? "");
        return u.githubLogin === "bob" ? "member" : "not_member";
      },
    });

    expect(asked.sort()).toEqual(["bob", "carol"]);
    expect(decisions).toEqual([
      { userId: "user-alice", allowed: true, via: "login" },
      { userId: "user-bob", allowed: true, via: "organization" },
      { userId: "user-carol", allowed: false, reason: "not_allowed" },
    ]);
  });

  // #106-IM-06
  it.each<OrgCheckOutcome>([
    "no_token",
    "undecryptable",
    "token_invalid",
    "unavailable",
  ])(
    "treats the outcome %s as blocked because the check failed",
    async (outcome) => {
      const decisions = await decideMembers({
        users: [user("alice", 1, 1)],
        config: parseAccessConfig({ ALLOWED_GITHUB_ORG: "acme" }, []),
        pins: new Map(),
        checkOrganization: async () => outcome,
      });

      expect(decisions).toEqual([
        { userId: "user-alice", allowed: false, reason: "check_failed" },
      ]);
    },
  );

  // #106-IM-06
  it("treats a check that throws as failed and does not affect the others", async () => {
    const decisions = await decideMembers({
      users: [user("alice", 1, 1), user("bob", 2, 2)],
      config: parseAccessConfig({ ALLOWED_GITHUB_ORG: "acme" }, []),
      pins: new Map(),
      checkOrganization: async (u) => {
        if (u.githubLogin === "alice") throw new Error("boom");
        return "member";
      },
    });

    expect(decisions.map((d) => d.allowed)).toEqual([false, true]);
  });

  it("admits nobody without a list and without an organization", async () => {
    const decisions = await decideMembers({
      users: [user("alice", 1, 1)],
      config: parseAccessConfig({}, []),
      pins: new Map(),
      checkOrganization: NO_ORGANIZATION,
    });

    expect(decisions).toEqual([
      { userId: "user-alice", allowed: false, reason: "not_allowed" },
    ]);
  });

  it("does not run more checks at the same time than allowed", async () => {
    let running = 0;
    let most = 0;

    await decideMembers({
      users: Array.from({ length: 12 }, (_, n) =>
        user(`u${String(n)}`, n + 1, 1),
      ),
      config: parseAccessConfig({ ALLOWED_GITHUB_ORG: "acme" }, []),
      pins: new Map(),
      concurrency: 3,
      checkOrganization: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        return "member";
      },
    });

    expect(most).toBeLessThanOrEqual(3);
    expect(most).toBeGreaterThan(1);
  });
});

describe("choosing the Owner", () => {
  // #106-IM-03
  it("is the earliest created user who was admitted", () => {
    const users = [user("alice", 1, 1), user("bob", 2, 2), user("carol", 3, 3)];

    const owner = pickOwner(users, [
      { userId: "user-alice", allowed: false, reason: "not_allowed" },
      { userId: "user-bob", allowed: true, via: "login" },
      { userId: "user-carol", allowed: true, via: "login" },
    ]);

    expect(owner).toBe("user-bob");
  });

  // #106-IM-08
  it("is nobody when nobody was admitted", () => {
    expect(
      pickOwner(
        [user("alice", 1, 1)],
        [{ userId: "user-alice", allowed: false, reason: "not_allowed" }],
      ),
    ).toBeNull();
  });
});
