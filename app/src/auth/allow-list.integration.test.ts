// Pins down who can complete a sign in: only an account on the logins list or in the allowed
// organization. A refused account lands on the login page with a clear code and leaves nothing
// behind (no user, account or session), and nobody can sign in when nothing is configured. Goes
// through the real Better Auth handler and the fake GitHub, against a real SQLite file.
import { describe, expect, it, vi } from "vitest";
import { loginErrorMessage } from "./login-errors.ts";
import {
  createAuthHarness,
  type AuthHarness,
} from "../test-support/auth-harness.ts";

const NOT_ALLOWED =
  "Your GitHub account is not allowed to use this Code Reviewer instance.";

const MALLORY = {
  id: 666001,
  login: "mallory",
  name: "Mallory",
  email: "mallory@example.test",
};
const HUBOT = {
  id: 666002,
  login: "hubot",
  name: "Hubot",
  email: null,
};
const OCTOCAT = {
  id: 583231,
  login: "octocat",
  name: "The Octocat",
  email: "octocat@example.test",
};

async function expectNothingStored(harness: AuthHarness) {
  for (const table of ["users", "accounts", "sessions"] as const)
    expect(await harness.db.selectFrom(table).selectAll().execute()).toEqual(
      [],
    );
}

function errorCodeOf(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  const url = new URL(location, "http://localhost:3000");
  expect(url.pathname).toBe("/login");
  return url.searchParams.get("error");
}

function sessionCookieOf(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find(
      (line) => line.includes("session_token=") && !/max-age=0/i.test(line),
    );
}

describe("signing in with a login that is on the list", () => {
  // CR-19-T01
  it("completes the sign in and creates the user and the session", async () => {
    const harness = await createAuthHarness({
      users: [OCTOCAT, HUBOT],
      allowedLogins: ["octocat", "hubot"],
    });

    const { response } = await harness.signIn("hubot");

    expect(response.headers.get("location")).toBe("/");
    expect(sessionCookieOf(response)).toBeDefined();
    const users = await harness.db.selectFrom("users").selectAll().execute();
    expect(users.map((user) => user.github_login)).toEqual(["hubot"]);
    expect(
      await harness.db.selectFrom("sessions").selectAll().execute(),
    ).toHaveLength(1);
  });

  // CR-19-T04
  it("completes the sign in although the list spells the login in another case", async () => {
    const harness = await createAuthHarness({ allowedLogins: ["OCTOCAT"] });

    const { response } = await harness.signIn("octocat");

    expect(response.headers.get("location")).toBe("/");
  });

  it("does not ask for the organization scope and does not call the membership endpoint", async () => {
    const harness = await createAuthHarness();

    const { authorizeUrl, cookies } = await harness.startSignIn();
    const scope = new URL(authorizeUrl ?? "").searchParams.get("scope");
    const callbackUrl = await harness.github.authorize(
      authorizeUrl ?? "",
      "octocat",
    );
    await harness.callback(callbackUrl, cookies);

    expect(scope).toBe("read:user");
    expect(
      harness.github.requests().filter((r) => r.path.includes("/memberships")),
    ).toEqual([]);
  });
});

describe("signing in with a login that is not on the list", () => {
  // CR-19-T07
  it("sends the person to the login page with the not-allowed code and stores nothing", async () => {
    const harness = await createAuthHarness({
      users: [OCTOCAT, MALLORY],
      allowedLogins: ["octocat", "hubot"],
    });

    const { response } = await harness.signIn("mallory");

    expect(response.status).toBe(302);
    expect(errorCodeOf(response)).toBe("not_allowed");
    expect(sessionCookieOf(response)).toBeUndefined();
    await expectNothingStored(harness);
  });

  // CR-19-T07
  it("shows the plain message, which names nobody else", async () => {
    const harness = await createAuthHarness({
      users: [OCTOCAT, MALLORY],
      allowedLogins: ["octocat", "hubot"],
    });

    const { response } = await harness.signIn("mallory");

    expect(loginErrorMessage(errorCodeOf(response) ?? "")).toBe(NOT_ALLOWED);
    const location = response.headers.get("location") ?? "";
    expect(location).not.toMatch(/octocat|hubot/);
  });

  // CR-19-T06
  it("does not let a login in that only contains or starts with a listed one", async () => {
    const harness = await createAuthHarness({
      users: [
        { ...MALLORY, id: 1, login: "octocat-evil" },
        { ...MALLORY, id: 2, login: "octocat2" },
        { ...MALLORY, id: 3, login: "cat" },
      ],
      allowedLogins: ["octocat"],
    });

    for (const login of ["octocat-evil", "octocat2", "cat"]) {
      const { response } = await harness.signIn(login);
      expect(errorCodeOf(response)).toBe("not_allowed");
    }

    await expectNothingStored(harness);
  });

  // CR-19-T08
  it("refuses a user who is in the database but no longer on the list, and creates no new session", async () => {
    const first = await createAuthHarness({ allowedLogins: ["octocat"] });
    await first.signIn("octocat");
    const second = first.restart({ allowedLogins: ["hubot"] });
    const usersBefore = await second.db
      .selectFrom("users")
      .selectAll()
      .execute();

    const { response } = await second.signIn("octocat");

    expect(errorCodeOf(response)).toBe("not_allowed");
    expect(sessionCookieOf(response)).toBeUndefined();
    expect(
      await second.db.selectFrom("sessions").selectAll().execute(),
    ).toHaveLength(1);
    expect(await second.db.selectFrom("users").selectAll().execute()).toEqual(
      usersBefore,
    );
  });

  it("does not replace the stored token of a refused user", async () => {
    const first = await createAuthHarness({ allowedLogins: ["octocat"] });
    await first.signIn("octocat");
    const second = first.restart({ allowedLogins: [] });
    const before = await second.db.selectFrom("accounts").selectAll().execute();

    await second.signIn("octocat");

    expect(
      await second.db.selectFrom("accounts").selectAll().execute(),
    ).toEqual(before);
  });
});

describe("signing in when nothing is configured", () => {
  // CR-19-T03
  it.each([
    ["an empty list", { allowedLogins: [] }],
    ["a list of blanks", { allowedLogins: [" ", ""] }],
  ])("lets nobody in with %s", async (_case, options) => {
    const harness = await createAuthHarness(options);

    const { response } = await harness.signIn("octocat");

    expect(errorCodeOf(response)).toBe("not_allowed");
    await expectNothingStored(harness);
  });
});

describe("signing in when access is given by organization", () => {
  // CR-19-T09
  it("completes the sign in for a member, asks for the organization scope, and notes the check", async () => {
    const harness = await createAuthHarness({ allowedOrg: "my-org" });
    harness.github.addOrgMember("my-org", "octocat");

    const { authorizeUrl, cookies } = await harness.startSignIn();
    const scope = new URL(authorizeUrl ?? "").searchParams.get("scope");
    const callbackUrl = await harness.github.authorize(
      authorizeUrl ?? "",
      "octocat",
    );
    const response = await harness.callback(callbackUrl, cookies);

    expect(scope).toBe("read:user read:org");
    expect(response.headers.get("location")).toBe("/");
    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(user.github_login).toBe("octocat");
    expect(Date.now() - Date.parse(user.org_checked_at ?? "")).toBeLessThan(
      60_000,
    );
    expect(
      await harness.db.selectFrom("sessions").selectAll().execute(),
    ).toHaveLength(1);
  });

  // CR-19-T10
  it("refuses a person who is not a member (404) and stores nothing", async () => {
    const harness = await createAuthHarness({ allowedOrg: "my-org" });

    const { response } = await harness.signIn("octocat");

    expect(errorCodeOf(response)).toBe("not_allowed");
    await expectNothingStored(harness);
  });

  it("refuses a person whose membership is only an invitation", async () => {
    const harness = await createAuthHarness({ allowedOrg: "my-org" });
    harness.github.addOrgMember("my-org", "octocat", "pending");

    const { response } = await harness.signIn("octocat");

    expect(errorCodeOf(response)).toBe("not_allowed");
    await expectNothingStored(harness);
  });

  it("refuses a member of another organization", async () => {
    const harness = await createAuthHarness({ allowedOrg: "my-org" });
    harness.github.addOrgMember("other-org", "octocat");

    const { response } = await harness.signIn("octocat");

    expect(errorCodeOf(response)).toBe("not_allowed");
  });

  // CR-19-T11
  it.each([403, 500, 502])(
    "refuses with a check-failed message when GitHub answers %i, and stores nothing",
    async (status) => {
      const harness = await createAuthHarness({ allowedOrg: "my-org" });
      harness.github.addOrgMember("my-org", "octocat");
      harness.github.failMembershipEndpoint({ kind: "status", status });

      const { response } = await harness.signIn("octocat");

      expect(errorCodeOf(response)).toBe("check_failed");
      expect(loginErrorMessage("check_failed")).toMatch(/could not check/i);
      await expectNothingStored(harness);
    },
  );

  // CR-19-T11
  it("refuses with a check-failed message when GitHub does not answer in time", async () => {
    const harness = await createAuthHarness({
      allowedOrg: "my-org",
      githubRequestTimeoutMs: 200,
    });
    harness.github.addOrgMember("my-org", "octocat");
    harness.github.failMembershipEndpoint({ kind: "delay", delayMs: 5000 });

    const { response } = await harness.signIn("octocat");

    expect(errorCodeOf(response)).toBe("check_failed");
    await expectNothingStored(harness);
  });

  it("does not leak the access token into the redirect or the logs when it refuses", async () => {
    const harness = await createAuthHarness({ allowedOrg: "my-org" });
    const output: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      });

    const { response } = await harness.signIn("octocat");

    const tokens = harness.github.issuedAccessTokens();
    expect(tokens).toHaveLength(1);
    const everything = [
      response.headers.get("location") ?? "",
      ...response.headers.getSetCookie(),
      ...output,
    ].join("\n");
    expect(everything).not.toContain(tokens[0]);
  });

  // CR-19-T08
  it("refuses a user who has left the organization, and creates no new session", async () => {
    const first = await createAuthHarness({ allowedOrg: "my-org" });
    first.github.addOrgMember("my-org", "octocat");
    await first.signIn("octocat");
    first.github.removeOrgMember("my-org", "octocat");

    const { response } = await first.signIn("octocat");

    expect(errorCodeOf(response)).toBe("not_allowed");
    expect(
      await first.db.selectFrom("sessions").selectAll().execute(),
    ).toHaveLength(1);
  });
});

describe("signing in when both the list and the organization are set", () => {
  // CR-19-T12
  it("lets a listed login in without asking the organization", async () => {
    const harness = await createAuthHarness({
      users: [OCTOCAT, MALLORY],
      allowedLogins: ["octocat"],
      allowedOrg: "my-org",
    });

    const { response } = await harness.signIn("octocat");

    expect(response.headers.get("location")).toBe("/");
    expect(
      harness.github.requests().filter((r) => r.path.includes("/memberships")),
    ).toEqual([]);
  });

  // CR-19-T12
  it("lets a member of the organization in who is not on the list", async () => {
    const harness = await createAuthHarness({
      users: [OCTOCAT, HUBOT],
      allowedLogins: ["octocat"],
      allowedOrg: "my-org",
    });
    harness.github.addOrgMember("my-org", "hubot");

    const { response } = await harness.signIn("hubot");

    expect(response.headers.get("location")).toBe("/");
  });

  // CR-19-T12
  it("keeps out somebody who is on neither", async () => {
    const harness = await createAuthHarness({
      users: [OCTOCAT, MALLORY],
      allowedLogins: ["octocat"],
      allowedOrg: "my-org",
    });

    const { response } = await harness.signIn("mallory");

    expect(errorCodeOf(response)).toBe("not_allowed");
    await expectNothingStored(harness);
  });
});
