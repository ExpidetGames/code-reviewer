// SPDX-License-Identifier: LicenseRef-Proprietary

// The first-run setup end to end below the browser: a real database, the real sign in, the real
// setup gate and session check in front of the two setup routes, and a code store with a clock the
// test moves. Pins down that the code is printed once and never sent over HTTP, that nothing but
// the health check and the setup is reachable before the setup is finished, how the code, the lock,
// the single use and the setup session behave, what completing creates, and what is gone afterwards.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { handleAuth } from "../test-support/sign-in-limiter.ts";
import { cookieHeader, type CookieJar } from "../test-support/auth-harness.ts";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
  SETUP_TEST_BASE_URL,
  SETUP_TEST_CODE,
  WIZARD_BODY,
  type SetupHarness,
} from "../test-support/setup-harness.ts";
import { SETUP_ATTEMPT_WINDOW_MS } from "./code-store.ts";
import { SETUP_SESSION_TTL_MS } from "./setup-session.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

async function started(options?: Parameters<typeof createSetupHarness>[0]) {
  const harness = await createSetupHarness(options);
  const start = await harness.start();
  return { harness, start };
}

/** Enters the code and returns the cookies of the browser that did it. */
async function enterCode(harness: SetupHarness, code = SETUP_TEST_CODE) {
  const cookies: CookieJar = new Map();
  const { response } = await harness.submitCode(code, cookies);
  expect(response.status).toBe(200);
  return cookies;
}

async function insertImportedUser(harness: SetupHarness, id: string) {
  await harness.db
    .insertInto("users")
    .values({
      id,
      name: id,
      email: `${id}@users.noreply.github.com`,
      email_verified: 0,
      image: null,
      github_login: id,
      imported_at: "2026-10-11T00:00:00.000Z",
      org_checked_at: null,
      org_checked_for: null,
      created_at: "2026-10-11T00:00:00.000Z",
      updated_at: "2026-10-11T00:00:00.000Z",
    })
    .execute();
}

describe("the setup code at start", () => {
  // #97-SU-01
  it("prints exactly one line with a six-digit code, and no response body ever contains it", async () => {
    const { harness, start } = await started();

    expect(start.setUp).toBe(false);
    expect(start.printed).toHaveLength(1);
    expect(start.printed[0]?.match(/\b\d{6}\b/g)).toEqual([SETUP_TEST_CODE]);

    const bodies: string[] = [];
    for (const [path, method] of [
      ["/", "GET"],
      ["/setup", "GET"],
      ["/projects", "GET"],
      ["/api/projects", "GET"],
      ["/api/health", "GET"],
      ["/api/webhooks/github-app", "POST"],
      ["/api/runners/v1/claim", "POST"],
    ] as const) {
      const response = await harness.visit(path, { method });
      bodies.push(await response.text(), [...response.headers].join("\n"));
    }
    const wrong = await harness.submitCode("000000");
    bodies.push(
      await wrong.response.text(),
      [...wrong.response.headers].join("\n"),
    );
    const right = await harness.submitCode(SETUP_TEST_CODE);
    bodies.push(
      await right.response.text(),
      [...right.response.headers].join("\n"),
    );
    expect(bodies.join("\n")).not.toContain(SETUP_TEST_CODE);
  });

  it("prints nothing on an instance that is set up", async () => {
    const harness = await createSetupHarness();
    await createInstanceSettingsRepository(harness.db).set(
      "setup_completed_at",
      "2026-10-11T07:00:00.000Z",
      null,
    );

    const start = await harness.start();

    expect(start).toEqual({ setUp: true, printed: [] });
  });

  // #97-SU-02
  it("prints a new code after a restart, and the new process refuses the code and the session of the old one", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);
    const second = harness.restart("135790");
    const restart = await second.start();

    expect(restart.printed[0]).toContain("135790");
    expect(restart.printed[0]).not.toContain(SETUP_TEST_CODE);
    const oldCode = await second.submitCode(SETUP_TEST_CODE);
    expect(oldCode.response.status).toBe(403);
    expect(await oldCode.response.json()).toEqual({ error: "invalid_code" });
    const oldSession = await second.complete(cookies);
    expect(oldSession.status).toBe(401);
    expect(await oldSession.json()).toEqual({
      error: "setup_session_required",
    });
    expect((await second.submitCode("135790")).response.status).toBe(200);
  });

  // #97-SU-16
  it("gives two processes over one database each their own code and counters, so a code of one is refused by the other", async () => {
    const { harness } = await started();
    const other = harness.restart("246810");
    await other.start();

    expect((await other.submitCode(SETUP_TEST_CODE)).response.status).toBe(403);
    expect((await harness.submitCode("246810")).response.status).toBe(403);
    expect((await harness.submitCode(SETUP_TEST_CODE)).response.status).toBe(
      200,
    );
    expect((await other.submitCode("246810")).response.status).toBe(200);
  });
});

describe("the gate on a fresh installation", () => {
  // #97-SU-03
  it("shows the setup for a page and answers setup_required for the API, webhooks and runner API", async () => {
    const { harness } = await started();

    const page = await harness.visit("/");
    const projects = await harness.visit("/api/projects");
    const webhook = await harness.visit("/api/webhooks/github-app", {
      method: "POST",
    });
    const claim = await harness.visit("/api/runners/v1/claim", {
      method: "POST",
    });

    // The proxy builds no address for the page: it marks the request and next.config.ts serves the
    // setup page (bug #155), so a client's X-Forwarded-Proto cannot make Next.js forward the rewrite
    // to another origin (a 500).
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("setup-page");
    for (const response of [projects, webhook, claim]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "setup_required" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  // #97-SU-03
  it("lets the health check and the setup page through", async () => {
    const { harness } = await started();

    expect(await (await harness.visit("/api/health")).text()).toBe("reached");
    expect(await (await harness.visit("/setup")).text()).toBe("setup-page");
  });
});

describe("entering the setup code", () => {
  // #97-SU-04
  it("refuses a wrong code without revealing digits", async () => {
    const { harness } = await started();

    const { response } = await harness.submitCode("482914");

    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid_code" });
    expect(text).not.toMatch(/\d{3}/);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  // #97-SU-05
  it("accepts the correct code, sets a setup session cookie and consumes the code", async () => {
    const { harness } = await started();

    const { response } = await harness.submitCode(SETUP_TEST_CODE);

    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().join("\n");
    expect(cookie).toContain("cr_setup_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain(SETUP_TEST_CODE);
  });

  // #97-SU-05
  it("sets the Secure attribute when the app is served over https", async () => {
    const { harness } = await started({ secureCookies: true });

    const { response } = await harness.submitCode(SETUP_TEST_CODE);

    expect(response.headers.getSetCookie().join("\n")).toContain("Secure");
  });

  // #97-SU-06
  it("refuses the consumed code from another client", async () => {
    const { harness } = await started();
    await enterCode(harness);

    const { response } = await harness.submitCode(SETUP_TEST_CODE, new Map());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "code_used" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  // #97-SU-07
  it("answers 429 with Retry-After for the sixth attempt within a minute, and accepts it after the window", async () => {
    const { harness } = await started();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await harness.submitCode("000000");

    const refused = await harness.submitCode(SETUP_TEST_CODE);

    expect(refused.response.status).toBe(429);
    expect(Number(refused.response.headers.get("retry-after"))).toBeGreaterThan(
      0,
    );
    expect(await refused.response.json()).toEqual({ error: "rate_limited" });

    harness.advance(SETUP_ATTEMPT_WINDOW_MS);

    expect((await harness.submitCode(SETUP_TEST_CODE)).response.status).toBe(
      200,
    );
  });

  // #97-SU-08
  it("locks after ten wrong attempts, refuses even the correct code, prints no new code, and a restart unlocks", async () => {
    const { harness, start } = await started();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await harness.submitCode("000000");
      harness.advance(SETUP_ATTEMPT_WINDOW_MS);
    }

    const locked = await harness.submitCode(SETUP_TEST_CODE);

    expect(locked.response.status).toBe(423);
    expect(await locked.response.json()).toEqual({ error: "setup_locked" });
    expect(start.printed).toHaveLength(1);
    expect(harness.logs).toEqual([]);

    const restarted = harness.restart("135790");
    const again = await restarted.start();
    expect(again.printed).toHaveLength(1);
    expect((await restarted.submitCode("135790")).response.status).toBe(200);
  });

  // #97-SU-21
  it("refuses a code that is 61 minutes old as expired", async () => {
    const { harness } = await started();
    harness.advance(61 * 60 * 1000);

    const { response } = await harness.submitCode(SETUP_TEST_CODE);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "code_expired" });
  });

  it("refuses a request from another site and one that is not JSON, before looking at the code", async () => {
    const { harness } = await started();

    const crossSite = await harness.visit("/api/setup/code", {
      method: "POST",
      body: { code: SETUP_TEST_CODE },
      headers: { "sec-fetch-site": "cross-site" },
    });
    const form = await harness.visit("/api/setup/code", {
      method: "POST",
      body: `code=${SETUP_TEST_CODE}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross_site_request" });
    expect(form.status).toBe(415);
    // Neither attempt counted nor consumed the code.
    expect((await harness.submitCode(SETUP_TEST_CODE)).response.status).toBe(
      200,
    );
  });
});

describe("the wizard", () => {
  // #97-SU-09
  it("refuses wizard requests once the setup session is older than 30 minutes, and a restart gives a new code", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);
    harness.advance(SETUP_SESSION_TTL_MS + 1000);

    const response = await harness.complete(cookies);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "setup_session_expired" });
    expect(await harness.db.selectFrom("users").select("id").execute()).toEqual(
      [],
    );

    const restarted = harness.restart("135790");
    await restarted.start();
    const fresh = await enterCode(restarted, "135790");
    expect((await restarted.complete(fresh)).status).toBe(200);
  });

  it("refuses the wizard without a setup session", async () => {
    const { harness } = await started();

    const response = await harness.complete(new Map());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "setup_session_required" });
  });

  it("refuses a forged setup session", async () => {
    const { harness } = await started();

    const response = await harness.complete(
      new Map([["cr_setup_session", "e30.AAAA"]]),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "setup_session_required" });
  });

  it("answers an invalid request with the fields and codes, and creates nothing", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);

    const response = await harness.complete(cookies, {
      ...WIZARD_BODY,
      admin: { email: "admin@example.com", password: "password1234" },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "admin.password", code: "password_too_common" }],
    });
    expect(await harness.db.selectFrom("users").select("id").execute()).toEqual(
      [],
    );
  });

  // #97-SU-11
  it("creates the admin and the default workspace as single-tenant, and signs the admin in", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);

    const response = await harness.complete(cookies);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, redirectTo: "/admin" });
    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      email: SETUP_TEST_ADMIN.email,
      is_instance_admin: 1,
    });
    const account = await harness.db
      .selectFrom("accounts")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(SETUP_TEST_ADMIN.password);
    expect(
      await harness.db.selectFrom("workspace_members").selectAll().execute(),
    ).toMatchObject([{ user_id: user.id, role: "owner" }]);
    const settings = createInstanceSettingsRepository(harness.db);
    expect(await settings.get("tenancy")).toBe("single");
    expect(await settings.get("setup_completed_at")).not.toBeNull();
    // The cookie the response set is a working session of the admin.
    const protectedPage = await harness.visit("/w/default/projects", {
      cookies,
    });
    expect(await protectedPage.text()).toBe("reached");
  });

  // #97-NOT-SET-UP
  it("runs the follow-up step once after a completed setup, and not after a refused one", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);

    await harness.complete(cookies, {
      ...WIZARD_BODY,
      admin: { email: "john..doe@example.com", password: "x7Kq-m2Vd9Lw" },
    });
    expect(harness.afterCompletedCount()).toBe(0);

    await harness.complete(cookies);
    await harness.complete(cookies);

    expect(harness.afterCompletedCount()).toBe(1);
  });

  // #97-EMAIL
  it("refuses an admin email address or password that the sign in would refuse, and creates nothing", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);

    for (const admin of [
      { email: "john..doe@example.com", password: "x7Kq-m2Vd9Lw" },
      { email: "admin@corp.c", password: "x7Kq-m2Vd9Lw" },
      { email: "o'brien@my_host.com", password: "x7Kq-m2Vd9Lw" },
      { email: "admin@example.com", password: "🔑".repeat(70) },
    ]) {
      const response = await harness.complete(cookies, {
        ...WIZARD_BODY,
        admin,
      });
      expect(response.status).toBe(422);
    }

    expect(await harness.db.selectFrom("users").select("id").execute()).toEqual(
      [],
    );
    expect(
      await createInstanceSettingsRepository(harness.db).get(
        "setup_completed_at",
      ),
    ).toBeUndefined();
    // The setup is still open: a good admin finishes it.
    expect((await harness.complete(cookies)).status).toBe(200);
  });

  // #97-SU-12
  it("creates the admin but no workspace as multi-tenant", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);

    const response = await harness.complete(cookies, {
      ...WIZARD_BODY,
      tenancy: "multi",
    });

    expect(response.status).toBe(200);
    expect(
      await harness.db.selectFrom("workspaces").select("id").execute(),
    ).toEqual([]);
    expect(
      await harness.db.selectFrom("users").select("id").execute(),
    ).toHaveLength(1);
  });

  it("lets the admin sign in with the password afterwards, and refuses a wrong one", async () => {
    const { harness } = await started();
    await harness.complete(await enterCode(harness));

    const signIn = (password: string) =>
      handleAuth(
        harness.auth,
        new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: SETUP_TEST_BASE_URL,
          },
          body: JSON.stringify({ email: SETUP_TEST_ADMIN.email, password }),
        }),
      );

    expect((await signIn(SETUP_TEST_ADMIN.password)).status).toBe(200);
    expect((await signIn("a-wrong-password-12")).status).toBe(401);
  });

  // #97-SU-13
  it("lets exactly one of two completions at the same moment win", async () => {
    const { harness } = await started();
    const cookies = await enterCode(harness);

    const responses = await Promise.all([
      harness.complete(cookies),
      harness.complete(cookies, {
        ...WIZARD_BODY,
        admin: { email: "second@example.com", password: "x7Kq-m2Vd9Lw" },
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const loser = responses.find((response) => response.status === 409);
    expect(await loser?.json()).toEqual({ error: "already_set_up" });
    expect(
      await harness.db.selectFrom("users").select("id").execute(),
    ).toHaveLength(1);
  });

  // #97-SU-19
  it("stores an email list or a domain rule, and nobody can sign up afterwards", async () => {
    for (const signUp of [
      { kind: "emails", entries: ["anna@example.com"] },
      { kind: "domains", entries: ["example.com"] },
    ] as const) {
      const { harness } = await started();
      const cookies = await enterCode(harness);

      const response = await harness.complete(cookies, {
        ...WIZARD_BODY,
        signUp,
      });

      expect(response.status).toBe(200);
      expect(
        await createInstanceSettingsRepository(harness.db).get("sign_up_rule"),
      ).toEqual(signUp);
      const signUpRequest = await handleAuth(
        harness.auth,
        new Request(`${SETUP_TEST_BASE_URL}/api/auth/sign-up/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: SETUP_TEST_BASE_URL,
          },
          body: JSON.stringify({
            email: "anna@example.com",
            password: "x7Kq-m2Vd9Lw",
            name: "Anna",
          }),
        }),
      );
      expect(signUpRequest.status).toBe(404);
      await expect(
        harness.auth.api.signUpEmail({
          body: {
            email: "anna@example.com",
            password: "x7Kq-m2Vd9Lw",
            name: "Anna",
          },
        }),
      ).rejects.toThrow();
      expect(
        await harness.db.selectFrom("users").select("id").execute(),
      ).toHaveLength(1);
    }
  });
});

describe("after the setup", () => {
  async function setUp() {
    const { harness } = await started();
    const cookies = await enterCode(harness);
    await harness.complete(cookies);
    return { harness, cookies };
  }

  // #97-SU-14
  it("answers 404 for the setup page and the setup API, refuses the old code, and sends a visitor without a session to the login", async () => {
    const { harness } = await setUp();

    expect((await harness.visit("/setup")).status).toBe(404);
    const code = await harness.submitCode(SETUP_TEST_CODE);
    expect(code.response.status).toBe(404);
    expect((await harness.complete(new Map())).status).toBe(404);
    const anonymous = await harness.visit("/projects");
    expect(anonymous.status).toBe(307);
    expect(anonymous.headers.get("location")).toBe(
      `${SETUP_TEST_BASE_URL}/login`,
    );
    expect((await harness.visit("/api/projects")).status).toBe(401);
  });

  // #97-SU-14
  it("keeps answering 404 from a process that is restarted after the setup", async () => {
    const { harness } = await setUp();
    const restarted = harness.restart("135790");

    const start = await restarted.start();

    expect(start).toEqual({ setUp: true, printed: [] });
    expect((await restarted.visit("/setup")).status).toBe(404);
    expect((await restarted.submitCode("135790")).response.status).toBe(404);
  });

  it("serves the webhooks and the runner API like any other route", async () => {
    const { harness } = await setUp();

    expect(
      await (
        await harness.visit("/api/webhooks/github-app", { method: "POST" })
      ).text(),
    ).toBe("reached");
    expect(
      await (
        await harness.visit("/api/runners/v1/claim", { method: "POST" })
      ).text(),
    ).toBe("reached");
  });
});

describe("an existing installation that is not set up", () => {
  async function existing() {
    const { harness } = await started();
    await insertImportedUser(harness, "imported-a");
    await createInstanceSettingsRepository(harness.db).set(
      "import_state",
      "done",
      null,
    );
    const workspace = await createWorkspacesRepository(harness.db).create({
      name: "Default workspace",
      slug: "default",
      createdBy: null,
    });
    await createWorkspacesRepository(harness.db).addMember(
      workspace.id,
      "imported-a",
      "owner",
    );
    const second = harness.restart();
    const start = await second.start();
    return { harness: second, start, workspace };
  }

  // #97-SU-22
  it("prints a code, gates the web UI, keeps the webhooks and the runner API working, and adds the admin as an Owner of the imported workspace", async () => {
    const { harness, start, workspace } = await existing();

    expect(start.setUp).toBe(false);
    expect(start.printed).toHaveLength(1);
    expect(await (await harness.visit("/")).text()).toBe("setup-page");
    expect((await harness.visit("/api/projects")).status).toBe(503);
    expect(
      await (
        await harness.visit("/api/webhooks/github-app", { method: "POST" })
      ).text(),
    ).toBe("reached");
    expect(
      await (
        await harness.visit("/api/runners/v1/claim", { method: "POST" })
      ).text(),
    ).toBe("reached");

    const cookies = await enterCode(harness);
    expect((await harness.complete(cookies)).status).toBe(200);

    const members = await harness.db
      .selectFrom("workspace_members")
      .select(["user_id", "role"])
      .where("workspace_id", "=", workspace.id)
      .execute();
    expect(members).toHaveLength(2);
    expect(members.every((member) => member.role === "owner")).toBe(true);
    expect(
      await harness.db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
    expect((await harness.visit("/api/projects", { cookies })).status).toBe(
      200,
    );
  });

  // #97-SU-23
  it("prints a new code after a restart before the wizard finished, shows the wizard again, and imports nothing twice", async () => {
    const { harness } = await existing();
    await enterCode(harness);
    const restarted = harness.restart("135790");

    const start = await restarted.start();

    expect(start.printed[0]).toContain("135790");
    expect(
      await createInstanceSettingsRepository(restarted.db).get(
        "setup_completed_at",
      ),
    ).toBeUndefined();
    expect(await (await restarted.visit("/")).text()).toBe("setup-page");
    expect((await restarted.submitCode("135790")).response.status).toBe(200);
    expect(
      await restarted.db.selectFrom("users").select("id").execute(),
    ).toHaveLength(1);
    expect(
      await restarted.db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
  });
});

describe("what the logs show", () => {
  // #97-SU-15
  it("shows no attempted or valid code, password or session token in the logs of a failed and a successful setup", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const { harness } = await started();

    await harness.submitCode("111111");
    await harness.submitCode("222222");
    const cookies = await enterCode(harness);
    const sessionToken = cookies.get("cr_setup_session") ?? "";
    await harness.complete(cookies, {
      ...WIZARD_BODY,
      admin: { email: "admin@example.com", password: "password1234" },
    });
    const done = await harness.complete(cookies);
    const adminSession =
      (done.headers
        .getSetCookie()
        .join(";")
        .match(/session_token=([^;]+)/) ?? [])[1] ?? "";

    const output = [...lines, ...harness.logs].join("\n");
    expect(sessionToken).not.toBe("");
    expect(adminSession).not.toBe("");
    for (const secret of [
      SETUP_TEST_CODE,
      "111111",
      "222222",
      SETUP_TEST_ADMIN.password,
      "password1234",
      sessionToken,
      adminSession,
      cookieHeader(cookies),
    ])
      if (secret !== "") expect(output).not.toContain(secret);
  });
});
