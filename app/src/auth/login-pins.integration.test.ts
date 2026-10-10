// Pins down that a login on the allow list is bound to one GitHub account: the first account to use
// it (or the id given as `login:id`) keeps it, an account that merely carries the same login (a
// renamed account's old name, taken by somebody else) is refused at sign in and on every request, and
// the bindings follow the list when the server restarts. Goes through the real Better Auth handler,
// the real access proxy and the fake GitHub, against a real SQLite file.
import { sql } from "kysely";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeGithubUser } from "../../../fakes/github/server.ts";
import { createAllowedLoginPinsRepository } from "../db/repositories/allowed-login-pins-repository.ts";
import { createAccessProxy } from "./access-proxy.ts";
import { loginErrorMessage } from "./login-errors.ts";
import { checkAuthConfigOnStart } from "./startup.ts";
import {
  TEST_AUTH_SECRET,
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type AuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";

const NOT_ALLOWED =
  "Your GitHub account is not allowed to use this Code Reviewer instance.";
const HOUR = 60 * 60 * 1000;

// The owner of the login, and the account that takes it over after the owner renamed.
const OWNER: FakeGithubUser = {
  id: 1001,
  login: "octocat",
  name: "The Octocat",
  email: null,
};
const SQUATTER: FakeGithubUser = {
  id: 2002,
  login: "octocat",
  name: "Not The Octocat",
  email: null,
};
const HUBOT: FakeGithubUser = {
  id: 3003,
  login: "hubot",
  name: "Hubot",
  email: null,
};

afterEach(() => {
  vi.useRealTimers();
});

function pinsOf(harness: AuthHarness) {
  return createAllowedLoginPinsRepository(harness.db);
}

function errorCodeOf(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  const url = new URL(location, TEST_BASE_URL);
  expect(url.pathname).toBe("/login");
  return url.searchParams.get("error");
}

function visitor(harness: AuthHarness) {
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getPolicy: () => harness.policy,
  });
  return (path: string, cookies: CookieJar) =>
    proxy(
      new NextRequest(`${TEST_BASE_URL}${path}`, {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
}

function passesThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

async function tableCounts(harness: AuthHarness) {
  return {
    users: await harness.db.selectFrom("users").selectAll().execute(),
    accounts: await harness.db.selectFrom("accounts").selectAll().execute(),
    sessions: await harness.db.selectFrom("sessions").selectAll().execute(),
  };
}

/**
 * The owner (1001) signed in and is bound to `octocat`, then renamed. The squatter (2002) took the
 * name and has a session from before the binding existed (it is removed and restored by hand).
 */
async function ownerAndSquatterWithSessions() {
  const harness = await createAuthHarness({
    users: [OWNER],
    allowedLogins: ["octocat"],
  });
  const owner = await harness.signIn(1001);
  harness.github.updateUser(1001, { login: "octocat-new" });
  harness.github.addUser(SQUATTER);
  await harness.db.deleteFrom("allowed_login_pins").execute();
  const squatter = await harness.signIn(2002);
  await harness.db.deleteFrom("allowed_login_pins").execute();
  await pinsOf(harness).pin("octocat", "1001");
  return { harness, owner: owner.cookies, squatter: squatter.cookies };
}

describe("the first sign in with a listed login", () => {
  // CR-42-T01
  it("signs in and binds the login to the id of the account", async () => {
    const harness = await createAuthHarness({
      users: [OWNER],
      allowedLogins: ["octocat"],
    });
    expect(await pinsOf(harness).list()).toEqual([]);

    const { response } = await harness.signIn(1001);

    expect(response.headers.get("location")).toBe("/");
    expect((await tableCounts(harness)).sessions).toHaveLength(1);
    const pins = await pinsOf(harness).list();
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ login: "octocat", githubId: "1001" });
    expect(Date.now() - Date.parse(pins[0]?.pinnedAt ?? "")).toBeLessThan(
      60_000,
    );
  });

  // CR-42-T02
  it("signs the same account in again, also when only the spelling of the login changed, and leaves the binding alone", async () => {
    const harness = await createAuthHarness({
      users: [OWNER],
      allowedLogins: ["octocat"],
    });
    await harness.signIn(1001);
    const [before] = await pinsOf(harness).list();
    harness.github.updateUser(1001, { login: "OctoCat" });

    const { response } = await harness.signIn(1001);

    expect(response.headers.get("location")).toBe("/");
    expect(await pinsOf(harness).list()).toEqual([before]);
    const { users } = await tableCounts(harness);
    expect(users.map((user) => user.github_login)).toEqual(["OctoCat"]);
  });
});

describe("an account that carries the login of the bound account", () => {
  // CR-42-T03
  it("is refused at sign in with the plain message, and nothing is stored or replaced", async () => {
    const harness = await createAuthHarness({
      users: [OWNER],
      allowedLogins: ["octocat"],
    });
    await harness.signIn(1001);
    harness.github.updateUser(1001, { login: "octocat-new" });
    harness.github.addUser(SQUATTER);
    const before = await tableCounts(harness);
    const pinsBefore = await pinsOf(harness).list();

    const { response } = await harness.signIn(2002);

    expect(response.status).toBe(302);
    expect(errorCodeOf(response)).toBe("not_allowed");
    expect(loginErrorMessage("not_allowed")).toBe(NOT_ALLOWED);
    expect(response.headers.getSetCookie().join("\n")).not.toMatch(
      /session_token=[^;]/,
    );
    expect(await tableCounts(harness)).toEqual(before);
    expect(await pinsOf(harness).list()).toEqual(pinsBefore);
  });

  // CR-42-T04
  it("is refused on a page with the not-allowed code, and its sessions are ended", async () => {
    const { harness, owner, squatter } = await ownerAndSquatterWithSessions();
    const visit = visitor(harness);

    const page = await visit("/", squatter);

    expect(page.status).toBe(307);
    const location = new URL(page.headers.get("location") ?? "");
    expect(location.pathname + location.search).toBe(
      "/login?error=not_allowed",
    );
    const { sessions } = await tableCounts(harness);
    expect(sessions).toHaveLength(1);
    // The next requests are plain unauthenticated requests: no session is left to refuse.
    const again = await visit("/", squatter);
    expect(new URL(again.headers.get("location") ?? "").search).toBe("");
    expect(passesThrough(await visit("/", owner))).toBe(true);
    expect(passesThrough(await visit("/api/jobs", owner))).toBe(true);
  });

  // CR-42-T04
  it("is refused on a data route with 403 and the reason, and then has no session", async () => {
    const { harness, owner, squatter } = await ownerAndSquatterWithSessions();
    const visit = visitor(harness);

    const first = await visit("/api/jobs", squatter);

    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({
      error: "ACCESS_DENIED",
      reason: "not_allowed",
    });
    const second = await visit("/api/jobs", squatter);
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(passesThrough(await visit("/api/jobs", owner))).toBe(true);
  });

  // CR-42-T04
  it("stays refused when the session is used again and again, and leaves the binding alone", async () => {
    const { harness, squatter } = await ownerAndSquatterWithSessions();
    const visit = visitor(harness);

    for (let i = 0; i < 4; i += 1)
      expect(passesThrough(await visit("/", squatter))).toBe(false);

    expect(await pinsOf(harness).find("octocat")).toBe("1001");
  });

  // CR-42 decision 2
  it("is bound to the account of a session that has no binding yet, on its next request", async () => {
    const harness = await createAuthHarness({
      users: [OWNER],
      allowedLogins: ["octocat"],
    });
    const { cookies } = await harness.signIn(1001);
    await harness.db.deleteFrom("allowed_login_pins").execute();

    expect(passesThrough(await visitor(harness)("/", cookies))).toBe(true);

    expect(await pinsOf(harness).find("octocat")).toBe("1001");
  });
});

describe("restarting the server with a changed list", () => {
  async function bothBound() {
    const first = await createAuthHarness({
      users: [OWNER, HUBOT],
      allowedLogins: ["octocat", "hubot"],
    });
    await first.signIn(1001);
    await first.signIn(3003);
    return first;
  }

  // CR-42-T05
  it("deletes the binding of a login that left the list and keeps the others as they were", async () => {
    const first = await bothBound();
    const hubot = (await pinsOf(first).list()).find(
      (pin) => pin.login === "hubot",
    );
    const second = first.restart({ allowedLogins: ["hubot"] });

    await second.start();

    expect(await pinsOf(second).list()).toEqual([hubot]);
    const { response } = await second.signIn("octocat");
    expect(errorCodeOf(response)).toBe("not_allowed");
  });

  // CR-42-T06
  it("lets a new account take over a login that was removed and added again, and refuses the old one", async () => {
    const first = await bothBound();
    const removed = first.restart({ allowedLogins: ["hubot"] });
    await removed.start();
    const added = removed.restart({ allowedLogins: ["octocat", "hubot"] });
    await added.start();
    added.github.updateUser(1001, { login: "octocat-new" });
    added.github.addUser(SQUATTER);

    const takeover = await added.signIn(2002);
    const owner = await added.signIn(1001);

    expect(takeover.response.headers.get("location")).toBe("/");
    expect(await pinsOf(added).find("octocat")).toBe("2002");
    // The owner signs in under the new name, which is not on the list; as `octocat` they are out.
    expect(errorCodeOf(owner.response)).toBe("not_allowed");
  });

  it("refuses the old account under the old login after the binding was reset", async () => {
    const first = await bothBound();
    const removed = first.restart({ allowedLogins: ["hubot"] });
    await removed.start();
    const added = removed.restart({ allowedLogins: ["octocat", "hubot"] });
    await added.start();
    added.github.addUser({ ...SQUATTER, login: "octocat" });
    await added.signIn(2002);

    const { response } = await added.signIn(1001);

    expect(errorCodeOf(response)).toBe("not_allowed");
    expect(await pinsOf(added).find("octocat")).toBe("2002");
  });

  it("deletes every binding when the list is empty", async () => {
    const first = await bothBound();
    const second = first.restart({ allowedLogins: [] });

    await second.start();

    expect(await pinsOf(second).list()).toEqual([]);
  });
});

describe("an id given in the list as login:id", () => {
  // CR-42-T07
  it("is bound when the server starts, before anybody signs in, and the login signs in", async () => {
    const harness = await createAuthHarness({
      users: [OWNER, HUBOT],
      allowedLogins: ["octocat:1001", "hubot"],
    });

    await harness.start();

    const pins = await pinsOf(harness).list();
    expect(pins.map((pin) => [pin.login, pin.githubId])).toEqual([
      ["octocat", "1001"],
    ]);
    const { response } = await harness.signIn(1001);
    expect(response.headers.get("location")).toBe("/");
    expect(await pinsOf(harness).find("hubot")).toBeNull();
  });

  // CR-42-T08
  it("keeps out an account that took the login and signs in first, and stores nothing for it", async () => {
    const harness = await createAuthHarness({
      users: [OWNER, SQUATTER],
      allowedLogins: ["octocat:1001"],
    });
    await harness.start();

    const { response } = await harness.signIn(2002);

    expect(errorCodeOf(response)).toBe("not_allowed");
    expect(await tableCounts(harness)).toEqual({
      users: [],
      accounts: [],
      sessions: [],
    });
    expect(await pinsOf(harness).find("octocat")).toBe("1001");
    expect((await harness.signIn(1001)).response.headers.get("location")).toBe(
      "/",
    );
  });

  // CR-42 decision 3
  it("replaces an existing binding with another id, logs one line without values, and the old account is out", async () => {
    const harness = await createAuthHarness({
      users: [SQUATTER],
      allowedLogins: ["octocat"],
    });
    await harness.signIn(2002);
    expect(await pinsOf(harness).find("octocat")).toBe("2002");
    const restarted = harness.restart({ allowedLogins: ["octocat:1001"] });
    const info = vi.fn<(message: string) => void>();

    await restarted.start(info);

    expect(await pinsOf(restarted).find("octocat")).toBe("1001");
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).not.toMatch(/octocat|1001|2002/);
    expect(line).not.toContain("\n");
    const { response } = await restarted.signIn(2002);
    expect(errorCodeOf(response)).toBe("not_allowed");
  });

  it("logs nothing when the pre-set id is the one already stored", async () => {
    const harness = await createAuthHarness({
      users: [OWNER],
      allowedLogins: ["octocat"],
    });
    await harness.signIn(1001);
    const restarted = harness.restart({ allowedLogins: ["octocat:1001"] });
    const info = vi.fn<(message: string) => void>();

    await restarted.start(info);

    expect(info).not.toHaveBeenCalled();
  });
});

describe("accounts that are not on the list", () => {
  // CR-42-T10
  it("are refused again and again and write no binding", async () => {
    const harness = await createAuthHarness({
      users: [
        { id: 11, login: "mallory", name: null, email: null },
        { id: 12, login: "octocat-evil", name: null, email: null },
        { id: 13, login: "octocat2", name: null, email: null },
      ],
      allowedLogins: ["octocat"],
    });

    for (const round of [1, 2])
      for (const who of ["mallory", "octocat-evil", "octocat2"]) {
        const { response } = await harness.signIn(who);
        expect(errorCodeOf(response), `${who} in round ${round}`).toBe(
          "not_allowed",
        );
      }

    expect(await pinsOf(harness).list()).toEqual([]);
  });
});

describe("two accounts with the same login that sign in at the same moment", () => {
  // CR-42-T11
  it.each([
    ["owner first", [1001, 2002]],
    ["squatter first", [2002, 1001]],
    ["owner first, again", [1001, 2002]],
    ["squatter first, again", [2002, 1001]],
  ] as const)(
    "let exactly one win and bind the login to it (%s)",
    async (_order, [firstId, secondId]) => {
      const harness = await createAuthHarness({
        users: [OWNER, SQUATTER],
        allowedLogins: ["octocat"],
      });
      const first = await harness.authorizeSignIn(firstId);
      const second = await harness.authorizeSignIn(secondId);
      harness.github.holdTokenRequests(2);

      const [firstResponse, secondResponse] = await Promise.all([
        harness.callback(first.callbackUrl, first.cookies),
        harness.callback(second.callbackUrl, second.cookies),
      ]);

      const responses = [
        { id: firstId, response: firstResponse },
        { id: secondId, response: secondResponse },
      ];
      const winners = responses.filter(
        ({ response }) => response.headers.get("location") === "/",
      );
      const losers = responses.filter(
        ({ response }) => response.headers.get("location") !== "/",
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(errorCodeOf(losers[0]?.response ?? new Response())).toBe(
        "not_allowed",
      );
      const { users, accounts, sessions } = await tableCounts(harness);
      expect(users).toHaveLength(1);
      expect(sessions).toHaveLength(1);
      expect(accounts.map((account) => account.account_id)).toEqual([
        String(winners[0]?.id),
      ]);
      expect(
        (await pinsOf(harness).list()).map((pin) => [pin.login, pin.githubId]),
      ).toEqual([["octocat", String(winners[0]?.id)]]);
    },
  );
});

describe("organization mode", () => {
  // CR-42-T12
  it("neither reads nor writes a binding (the table is not even there), for sign in, requests and the 24 hour check", async () => {
    const harness = await createAuthHarness({
      users: [OWNER, HUBOT],
      allowedOrg: "my-org",
    });
    harness.github.addOrgMember("my-org", "octocat");
    await sql`drop table allowed_login_pins`.execute(harness.db);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });

    const member = await harness.signIn(1001);
    const stranger = await harness.signIn(3003);
    const visit = visitor(harness);

    expect(member.response.headers.get("location")).toBe("/");
    expect(errorCodeOf(stranger.response)).toBe("not_allowed");
    expect(passesThrough(await visit("/", member.cookies))).toBe(true);
    vi.setSystemTime(Date.now() + 25 * HOUR);
    expect(passesThrough(await visit("/", member.cookies))).toBe(true);
  });

  // CR-42 decision 5
  it("admits a member whose login is on the list but bound to another account, and still refuses a non-member", async () => {
    const harness = await createAuthHarness({
      users: [OWNER],
      allowedLogins: ["octocat"],
      allowedOrg: "my-org",
    });
    await harness.signIn(1001);
    harness.github.updateUser(1001, { login: "octocat-new" });
    harness.github.addUser(SQUATTER);

    const outsider = await harness.signIn(2002);
    expect(errorCodeOf(outsider.response)).toBe("not_allowed");

    harness.github.addOrgMember("my-org", "octocat");
    const member = await harness.signIn(2002);
    expect(member.response.headers.get("location")).toBe("/");
    expect(passesThrough(await visitor(harness)("/", member.cookies))).toBe(
      true,
    );
    expect(await pinsOf(harness).find("octocat")).toBe("1001");
  });
});

describe("what a refusal tells the person", () => {
  // CR-42-T13
  it("never contains an id, another listed login, a token or the secret, and looks like any other refusal", async () => {
    const output: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      });
    const harness = await createAuthHarness({
      users: [
        OWNER,
        HUBOT,
        { id: 666, login: "mallory", name: null, email: null },
      ],
      allowedLogins: ["octocat", "hubot"],
    });
    await harness.signIn(1001);
    await harness.signIn(3003);
    harness.github.updateUser(1001, { login: "octocat-new" });
    harness.github.addUser(SQUATTER);
    const evidence: string[] = [];

    // The refusal at sign in, next to the refusal of a login that is simply not listed.
    const impostor = await harness.signIn(2002);
    const stranger = await harness.signIn("mallory");
    expect(impostor.response.headers.get("location")).toBe(
      stranger.response.headers.get("location"),
    );
    expect(await impostor.response.text()).toBe(await stranger.response.text());
    evidence.push(
      impostor.response.headers.get("location") ?? "",
      loginErrorMessage(errorCodeOf(impostor.response) ?? "") ?? "",
    );

    // The refusal on a request: a page and a data route (a fresh session of the impostor each).
    for (const path of ["/", "/api/jobs"]) {
      await harness.db.deleteFrom("allowed_login_pins").execute();
      const session = await harness.signIn(2002);
      await harness.db.deleteFrom("allowed_login_pins").execute();
      await pinsOf(harness).pin("octocat", "1001");
      const refusal = await visitor(harness)(path, session.cookies);
      evidence.push(
        refusal.headers.get("location") ?? "",
        await refusal.text(),
      );
    }

    // The start: an invalid login:id entry next to a valid one.
    const warnings: string[] = [];
    checkAuthConfigOnStart({
      env: {
        BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
        BETTER_AUTH_URL: TEST_BASE_URL,
        GITHUB_OAUTH_CLIENT_ID: "id",
        GITHUB_OAUTH_CLIENT_SECRET: "secret-value",
        ALLOWED_GITHUB_LOGINS: "octocat:1001,hubot:3003x,mallory:1001:2002",
      },
      log: (line) => warnings.push(line),
      warn: (line) => warnings.push(line),
      exit: vi.fn(),
    });
    expect(warnings).toHaveLength(1);
    evidence.push(...warnings);

    const everything = [...evidence, ...output].join("\n");
    for (const forbidden of [
      "1001",
      "2002",
      "3003",
      "hubot",
      TEST_AUTH_SECRET,
      ...harness.github.issuedAccessTokens(),
    ])
      expect(everything).not.toContain(forbidden);
  });
});
