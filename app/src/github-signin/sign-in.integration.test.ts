// SPDX-License-Identifier: Apache-2.0

// Signing in with GitHub through the GitHub App's user authorization, end to end through the real Better
// Auth handler and the fake GitHub, against a real SQLite file: who is created, who is linked, who is
// refused, and what is written when somebody is refused (nothing). The sign-up rule is applied to the
// verified primary email address of the GitHub account, an identity is matched by its numeric GitHub id,
// and an address alone never links two accounts.
import { describe, expect, it } from "vitest";
import type { FakeGithubUser } from "../../../fakes/github/server.ts";
import {
  OCTOCAT,
  createAuthHarness,
  type AuthHarness,
} from "../test-support/auth-harness.ts";
import { insertUser } from "../test-support/users.ts";

const PLACEHOLDER = `${String(OCTOCAT.id)}@users.noreply.github.com`;

function errorOf(response: Response): string | null {
  const location = response.headers.get("location");
  if (location === null) return null;
  return new URL(location, "http://localhost:3000").searchParams.get("error");
}

async function counts(harness: AuthHarness) {
  const [users, accounts, sessions] = await Promise.all([
    harness.db.selectFrom("users").select("id").execute(),
    harness.db.selectFrom("accounts").select("id").execute(),
    harness.db.selectFrom("sessions").select("id").execute(),
  ]);
  return {
    users: users.length,
    accounts: accounts.length,
    sessions: sessions.length,
  };
}

describe("signing in with GitHub for the first time", () => {
  // #102-GH-11
  it("creates a user with the verified primary email, the GitHub login and a GitHub identity, and one session", async () => {
    const harness = await createAuthHarness();

    const { response } = await harness.signIn("octocat");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      name: "The Octocat",
      github_login: "octocat",
      email: "octocat@example.test",
      email_verified: 1,
      imported_at: null,
      is_instance_admin: 0,
    });
    const accounts = await harness.db
      .selectFrom("accounts")
      .selectAll()
      .execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      provider_id: "github",
      account_id: String(OCTOCAT.id),
      user_id: user.id,
      password: null,
    });
    expect(await counts(harness)).toEqual({
      users: 1,
      accounts: 1,
      sessions: 1,
    });
  });

  // #101-follow-up: the invitation link survives the sign in with GitHub
  it("brings an invitee back to the page of the invitation, new account or known one", async () => {
    const token = "B".repeat(43);
    const landing = `/invitation?token=${token}`;
    const harness = await createAuthHarness();
    const finish = async () => {
      const started = await harness.startSignIn({ callbackURL: landing });
      const callbackUrl = await harness.github.authorize(
        started.authorizeUrl ?? "",
        "octocat",
      );
      return harness.callback(callbackUrl, started.cookies);
    };

    const first = await finish();
    const again = await finish();

    expect(first.headers.get("location")).toBe(landing);
    expect(again.headers.get("location")).toBe(landing);
  });

  // #101-follow-up: no open redirect through the callback address
  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "javascript:alert(1)",
  ])(
    "refuses a callback address that leaves the site: %s",
    async (callbackURL) => {
      const harness = await createAuthHarness();

      const started = await harness.startSignIn({ callbackURL });

      expect(started.response.status).toBeGreaterThanOrEqual(400);
      expect(started.authorizeUrl).toBeUndefined();
      expect(await counts(harness)).toEqual({
        users: 0,
        accounts: 0,
        sessions: 0,
      });
    },
  );

  // #102-GH-11
  it("reads the addresses with the user token of the App and asks for no scope", async () => {
    const harness = await createAuthHarness();

    const { authorizeUrl } = await harness.startSignIn();

    expect(new URL(authorizeUrl ?? "").searchParams.get("scope")).toBeNull();
    await harness.signIn("octocat");
    expect(harness.github.requests().map((request) => request.path)).toEqual(
      expect.arrayContaining(["/user", "/user/emails"]),
    );
  });

  // #102-GH-14
  it.each([
    ["has no address at all", { email: null, emails: [] }],
    [
      "has only an unverified primary address",
      {
        email: null,
        emails: [{ email: "a@example.test", primary: true, verified: false }],
      },
    ],
    [
      "has a verified address that is not the primary one",
      {
        email: null,
        emails: [
          { email: "a@example.test", primary: false, verified: true },
          { email: "b@example.test", primary: true, verified: false },
        ],
      },
    ],
  ] as Array<[string, Partial<FakeGithubUser>]>)(
    "is refused with github_email_unverified, and writes nothing, when the account %s",
    async (_case, overrides) => {
      const harness = await createAuthHarness({
        users: [{ ...OCTOCAT, ...overrides }],
      });

      const { response } = await harness.signIn();

      expect(errorOf(response)).toBe("github_email_unverified");
      expect(await counts(harness)).toEqual({
        users: 0,
        accounts: 0,
        sessions: 0,
      });
    },
  );

  // #102-GH-14
  it("is refused with check_failed, and writes nothing, when the addresses cannot be read", async () => {
    const harness = await createAuthHarness();
    harness.github.fail({ pathIncludes: "/user/emails", status: 500 });

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe("check_failed");
    expect(await counts(harness)).toEqual({
      users: 0,
      accounts: 0,
      sessions: 0,
    });
  });

  // #102-GH-14
  it("is refused with check_failed when the App lacks the permission to read the addresses", async () => {
    const harness = await createAuthHarness();
    harness.github.setAppAccountPermissions({});

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe("check_failed");
    expect(await counts(harness)).toEqual({
      users: 0,
      accounts: 0,
      sessions: 0,
    });
  });
});

describe("the sign-up rule on the verified GitHub address", () => {
  // #102-SR-15
  it.each([
    [{ kind: "emails", entries: ["octocat@example.test"] }, true],
    [{ kind: "emails", entries: ["someone@example.test"] }, false],
    [{ kind: "domains", entries: ["example.test"] }, true],
    [{ kind: "domains", entries: ["other.test"] }, false],
    [{ kind: "domains", entries: ["test"] }, false],
  ] as const)("lets a new account in by %j: %s", async (rule, allowed) => {
    const harness = await createAuthHarness({
      signUpRule: rule as never,
      // GitHub is the way to verify addresses here: it is the only way in.
      signInMethods: { emailPassword: false, github: true },
    });

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe(allowed ? null : "email_not_allowed");
    expect((await counts(harness)).users).toBe(allowed ? 1 : 0);
  });

  // #102-SR-16
  it("is closed for a rule that names addresses while nothing can verify them", async () => {
    const harness = await createAuthHarness({
      signUpRule: { kind: "domains", entries: ["example.test"] },
      // Email with password is on and there is no mail server: no path verifies an address.
      signInMethods: { emailPassword: true, github: true },
      mailConfigured: false,
    });

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe("signup_closed");
    expect(await counts(harness)).toEqual({
      users: 0,
      accounts: 0,
      sessions: 0,
    });
  });

  // #102-SR-26
  it("never lets an address of the placeholder domain in, whatever the rule", async () => {
    const harness = await createAuthHarness({
      users: [
        {
          ...OCTOCAT,
          email: null,
          emails: [
            {
              email: "583231+octocat@users.noreply.github.com",
              primary: true,
              verified: true,
            },
          ],
        },
      ],
    });

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe("email_not_allowed");
  });

  it("does not ask the rule again for an account that exists already", async () => {
    const harness = await createAuthHarness({
      signUpRule: { kind: "emails", entries: ["octocat@example.test"] },
      signInMethods: { emailPassword: false, github: true },
    });
    await harness.signIn();
    harness.facts.rule = { kind: "emails", entries: ["nobody@example.test"] };

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    expect((await counts(harness)).users).toBe(1);
  });
});

describe("signing in again", () => {
  // #102-GH-12
  it("signs a user the previous sign in created in as the same user, matched by the numeric GitHub id", async () => {
    const harness = await createAuthHarness();
    // As the previous release left it: a placeholder address, unverified, and the GitHub identity.
    await insertUser(harness.db, {
      id: "legacy-user",
      name: "Legacy",
      email: PLACEHOLDER,
      githubLogin: "old-login",
      githubId: String(OCTOCAT.id),
    });

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    const users = await harness.db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: "legacy-user",
      github_login: "octocat",
      name: "The Octocat",
      // Not imported: nothing replaces the address of a user who is not marked as imported.
      email: PLACEHOLDER,
      email_verified: 0,
    });
    const sessions = await harness.db
      .selectFrom("sessions")
      .selectAll()
      .execute();
    expect(sessions.map((session) => session.user_id)).toEqual(["legacy-user"]);
  });

  // #102-GH-12
  it("keeps one user and updates name and login when the GitHub account was renamed", async () => {
    const harness = await createAuthHarness();
    await harness.signIn("octocat");
    const before = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    harness.github.updateUser(OCTOCAT.id, {
      login: "octocat-renamed",
      name: "The Renamed Octocat",
    });

    await harness.signIn("octocat-renamed");

    const users = await harness.db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: before.id,
      name: "The Renamed Octocat",
      github_login: "octocat-renamed",
      email: before.email,
    });
    expect((await counts(harness)).accounts).toBe(1);
    expect((await counts(harness)).sessions).toBe(2);
  });

  it("does not change the address of the user when GitHub reports another one later", async () => {
    const harness = await createAuthHarness();
    await harness.signIn("octocat");
    harness.github.updateUser(OCTOCAT.id, {
      email: "new@example.test",
      emails: [{ email: "new@example.test", primary: true, verified: true }],
    });

    await harness.signIn("octocat");

    const user = await harness.db
      .selectFrom("users")
      .select("email")
      .executeTakeFirstOrThrow();
    expect(user.email).toBe("octocat@example.test");
  });

  it("signs in a user whose identity is known even when the addresses cannot be read", async () => {
    const harness = await createAuthHarness();
    await harness.signIn("octocat");
    harness.github.fail({ pathIncludes: "/user/emails", status: 500 });

    const { response } = await harness.signIn("octocat");

    expect(response.headers.get("location")).toBe("/");
  });
});

describe("an account that has the verified address of the GitHub account", () => {
  async function withAccount(options: {
    emailVerified: boolean;
    githubEmail?: FakeGithubUser["emails"];
  }) {
    const harness = await createAuthHarness({
      users: [
        options.githubEmail === undefined
          ? OCTOCAT
          : { ...OCTOCAT, emails: options.githubEmail },
      ],
    });
    await insertUser(harness.db, {
      id: "owner",
      email: "octocat@example.test",
      emailVerified: options.emailVerified,
      passwordHash: "a-password-hash",
    });
    return harness;
  }

  // #102-GH-13
  it("is linked to the GitHub identity when both addresses are verified, without a second user", async () => {
    const harness = await withAccount({ emailVerified: true });

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    expect((await counts(harness)).users).toBe(1);
    const github = await harness.db
      .selectFrom("accounts")
      .select(["user_id", "account_id"])
      .where("provider_id", "=", "github")
      .executeTakeFirstOrThrow();
    expect(github).toEqual({
      user_id: "owner",
      account_id: String(OCTOCAT.id),
    });
    const sessions = await harness.db
      .selectFrom("sessions")
      .selectAll()
      .execute();
    expect(sessions.map((session) => session.user_id)).toEqual(["owner"]);
  });

  // #102-GH-13
  it("is not linked when its own address is not verified, and nothing is written", async () => {
    const harness = await withAccount({ emailVerified: false });

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe("email_exists_unverified");
    expect(await counts(harness)).toEqual({
      users: 1,
      accounts: 1,
      sessions: 0,
    });
  });

  // #102-GH-13
  it("is not linked when GitHub does not report the address as verified", async () => {
    const harness = await withAccount({
      emailVerified: true,
      githubEmail: [
        { email: "octocat@example.test", primary: true, verified: false },
      ],
    });

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe("github_email_unverified");
    expect(await counts(harness)).toEqual({
      users: 1,
      accounts: 1,
      sessions: 0,
    });
  });

  // #102-GH-13
  it("is not linked when GitHub reports the address as a secondary one, only the primary counts", async () => {
    const harness = await withAccount({
      emailVerified: true,
      githubEmail: [
        { email: "octocat@example.test", primary: false, verified: true },
        { email: "other@example.test", primary: true, verified: true },
      ],
    });

    const { response } = await harness.signIn();

    // The primary address is another one: a new account is made for it; the existing account is left alone.
    expect(response.headers.get("location")).toBe("/");
    expect((await counts(harness)).users).toBe(2);
    const owner = await harness.db
      .selectFrom("accounts")
      .select("provider_id")
      .where("user_id", "=", "owner")
      .execute();
    expect(owner.map((account) => account.provider_id)).toEqual(["credential"]);
  });

  // #102-GH-13
  it("is never given a second GitHub identity, so a GitHub account that took over the address cannot reach it", async () => {
    const harness = await withAccount({ emailVerified: true });
    await insertUser(harness.db, {
      id: "other-owner",
      email: "someone@example.test",
      emailVerified: true,
    });
    // The account already has a GitHub identity (another GitHub account).
    await harness.db
      .insertInto("accounts")
      .values({
        id: "github-owner",
        account_id: "111",
        provider_id: "github",
        user_id: "owner",
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: null,
        created_at: "2026-10-11T08:00:00.000Z",
        updated_at: "2026-10-11T08:00:00.000Z",
      })
      .execute();

    const { response } = await harness.signIn();

    expect(errorOf(response)).toBe("github_identity_conflict");
    const owner = await harness.db
      .selectFrom("accounts")
      .select(["provider_id", "account_id"])
      .where("user_id", "=", "owner")
      .orderBy("provider_id")
      .execute();
    expect(owner).toEqual([
      { provider_id: "credential", account_id: "owner" },
      { provider_id: "github", account_id: "111" },
    ]);
  });
});

describe("an imported user's placeholder address", () => {
  async function importedUser(harness: AuthHarness) {
    await insertUser(harness.db, {
      id: "imported",
      name: "Imported",
      email: PLACEHOLDER,
      githubLogin: "octocat",
      githubId: String(OCTOCAT.id),
      importedAt: "2026-10-11T08:00:00.000Z",
    });
  }

  // #102-GH-26
  it("is replaced by the verified primary email at the next GitHub sign in, and marked verified", async () => {
    const harness = await createAuthHarness();
    await importedUser(harness);

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    const user = await harness.db
      .selectFrom("users")
      .select(["id", "email", "email_verified", "email_conflict"])
      .executeTakeFirstOrThrow();
    expect(user).toEqual({
      id: "imported",
      email: "octocat@example.test",
      email_verified: 1,
      email_conflict: null,
    });
  });

  // #102-GH-27
  it("stays when the verified primary email belongs to another account, nothing is taken over or merged, and the conflict is recorded", async () => {
    const harness = await createAuthHarness();
    await importedUser(harness);
    await insertUser(harness.db, {
      id: "holder",
      email: "octocat@example.test",
      emailVerified: true,
      passwordHash: "hash",
    });

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    const imported = await harness.db
      .selectFrom("users")
      .select(["id", "email", "email_verified", "email_conflict"])
      .where("id", "=", "imported")
      .executeTakeFirstOrThrow();
    expect(imported).toEqual({
      id: "imported",
      email: PLACEHOLDER,
      email_verified: 0,
      email_conflict: "octocat@example.test",
    });
    // The other account is untouched, and no third account exists.
    expect((await counts(harness)).users).toBe(2);
    const holderAccounts = await harness.db
      .selectFrom("accounts")
      .select("provider_id")
      .where("user_id", "=", "holder")
      .execute();
    expect(holderAccounts.map((account) => account.provider_id)).toEqual([
      "credential",
    ]);
    const sessions = await harness.db
      .selectFrom("sessions")
      .selectAll()
      .execute();
    expect(sessions.map((session) => session.user_id)).toEqual(["imported"]);
  });

  // #102-GH-27
  it("clears the conflict once the address is free and the user signs in again", async () => {
    const harness = await createAuthHarness();
    await importedUser(harness);
    await insertUser(harness.db, {
      id: "holder",
      email: "octocat@example.test",
      emailVerified: true,
    });
    await harness.signIn();
    await harness.db.deleteFrom("users").where("id", "=", "holder").execute();

    await harness.signIn();

    const imported = await harness.db
      .selectFrom("users")
      .select(["email", "email_verified", "email_conflict"])
      .where("id", "=", "imported")
      .executeTakeFirstOrThrow();
    expect(imported).toEqual({
      email: "octocat@example.test",
      email_verified: 1,
      email_conflict: null,
    });
  });

  it("is kept when GitHub reports no verified primary address; the user signs in all the same", async () => {
    const harness = await createAuthHarness({
      users: [{ ...OCTOCAT, email: null, emails: [] }],
    });
    await importedUser(harness);

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    const user = await harness.db
      .selectFrom("users")
      .select(["email", "email_verified"])
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ email: PLACEHOLDER, email_verified: 0 });
  });
});

describe("a second GitHub account that has the same address", () => {
  it("is not given the user of the first: the identity is the GitHub id, never the address", async () => {
    const harness = await createAuthHarness({
      users: [
        OCTOCAT,
        {
          id: 999001,
          login: "other-account",
          name: "Other",
          email: OCTOCAT.email,
        },
      ],
    });
    await harness.signIn("octocat");

    const { response } = await harness.signIn("other-account");

    expect(errorOf(response)).toBe("github_identity_conflict");
    expect((await counts(harness)).users).toBe(1);
  });
});
