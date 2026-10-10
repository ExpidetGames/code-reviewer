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
      email: "octocat@example.test",
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

describe("signing in with a GitHub account that hides its email address", () => {
  // CR-18-T06
  it("takes the primary verified address from the email list", async () => {
    const harness = await createAuthHarness({
      users: [
        {
          ...OCTOCAT,
          email: null,
          emails: [
            { email: "other@example.test", primary: false, verified: true },
            { email: "private@example.test", primary: true, verified: true },
          ],
        },
      ],
    });

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      email: "private@example.test",
      email_verified: 1,
      github_login: "octocat",
    });
  });

  // CR-18-T06
  it("uses the GitHub noreply address for the account id when no address can be read at all", async () => {
    const harness = await createAuthHarness({
      users: [{ ...OCTOCAT, email: null, emails: [] }],
    });

    const { response } = await harness.signIn();

    expect(response.headers.get("location")).toBe("/");
    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(user.email).toBe(`${String(OCTOCAT.id)}@users.noreply.github.com`);
    expect(user.email_verified).toBe(0);
  });
});

describe("signing in with a second GitHub account that has the same email address", () => {
  // Extra case beyond the Jira table: the user follows the GitHub id, not the email address.
  it("does not give it the user of the first account", async () => {
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

    expect(response.headers.get("location")).toContain("/login?error=");
    const users = await harness.db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ github_login: "octocat" });
    expect(
      await harness.db.selectFrom("sessions").selectAll().execute(),
    ).toHaveLength(1);
  });
});
