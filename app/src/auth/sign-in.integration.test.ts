// SPDX-License-Identifier: Apache-2.0

// Pins down what a completed GitHub sign in leaves in the database: one user with the GitHub name
// and login, an account bound to the GitHub id, and one session; and how a later sign in of the same
// GitHub account (renamed, without a public email) behaves. Goes through the real Better Auth
// handler and the fake GitHub, against a real SQLite file.
import { describe, expect, it } from "vitest";
import { OCTOCAT, createAuthHarness } from "../test-support/auth-harness.ts";

describe("signing in with GitHub for the first time", () => {
  // CR-18-T04
  it("creates exactly one user with the GitHub name and login, and one session", async () => {
    const harness = await createAuthHarness();

    const { response } = await harness.signIn("octocat");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const users = await harness.db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      name: "The Octocat",
      github_login: "octocat",
      email: `${String(OCTOCAT.id)}@users.noreply.github.com`,
    });
    const accounts = await harness.db
      .selectFrom("accounts")
      .selectAll()
      .execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      provider_id: "github",
      account_id: String(OCTOCAT.id),
      user_id: users[0]?.id,
    });
    const sessions = await harness.db
      .selectFrom("sessions")
      .selectAll()
      .execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.user_id).toBe(users[0]?.id);
  });
});

describe("signing in again", () => {
  // CR-18-T05
  it("keeps one user and updates name and login when the GitHub account was renamed", async () => {
    const harness = await createAuthHarness({
      allowedLogins: ["octocat", "octocat-renamed"],
    });
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
    });
    const accounts = await harness.db
      .selectFrom("accounts")
      .selectAll()
      .execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.account_id).toBe(String(OCTOCAT.id));
    expect(
      await harness.db.selectFrom("sessions").selectAll().execute(),
    ).toHaveLength(2);
  });
});

describe("the email address of a signed in user", () => {
  // CR-18-T06
  it.each([
    ["has a public address", { email: "octocat@example.test" }],
    ["hides the address", { email: null, emails: [] }],
    [
      "hides it but lists one",
      {
        email: null,
        emails: [
          { email: "private@example.test", primary: true, verified: true },
        ],
      },
    ],
  ])(
    "is the GitHub noreply address of the account id when the account %s, and the sign in succeeds",
    async (_case, overrides) => {
      const harness = await createAuthHarness({
        users: [{ ...OCTOCAT, ...overrides }],
      });

      const { response } = await harness.signIn();

      expect(response.headers.get("location")).toBe("/");
      const user = await harness.db
        .selectFrom("users")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(user.email).toBe(`${String(OCTOCAT.id)}@users.noreply.github.com`);
      expect(user.email_verified).toBe(0);
      expect(user.github_login).toBe("octocat");
    },
  );

  // CR-18-T06
  it("is not read from GitHub at all", async () => {
    const harness = await createAuthHarness();

    await harness.signIn();

    expect(
      harness.github.requests().map((request) => request.path),
    ).not.toContain("/user/emails");
  });
});

describe("signing in with a second GitHub account that has the same public email address", () => {
  // Extra case beyond the Jira table: the user follows the GitHub id, never the email address.
  it("gives it a user of its own and leaves the first one alone", async () => {
    const harness = await createAuthHarness({
      users: [
        OCTOCAT,
        {
          id: 999001,
          login: "other-account",
          name: "Other Account",
          email: OCTOCAT.email,
        },
      ],
    });
    await harness.signIn("octocat");

    const { response } = await harness.signIn("other-account");

    expect(response.headers.get("location")).toBe("/");
    const users = await harness.db
      .selectFrom("users")
      .select(["github_login", "name"])
      .orderBy("github_login")
      .execute();
    expect(users).toEqual([
      { github_login: "octocat", name: "The Octocat" },
      { github_login: "other-account", name: "Other Account" },
    ]);
  });
});
