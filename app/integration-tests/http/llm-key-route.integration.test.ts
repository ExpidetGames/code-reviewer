// SPDX-License-Identifier: Apache-2.0

// The routes of the LLM key of a workspace through the real route files, with the wiring the running server
// uses (the database opened at start, the secret store, the workspace access); only the session lookup and
// `connection()` are replaced, they need Next.js's request scope. The fake LLM stands in for the provider.
//
// What is pinned down: an Admin or an Owner sets, replaces, tests and removes the key; a Member sees only whether
// one exists and is refused everything else; the key is encrypted at rest and in no answer, log line or error;
// the request is read the one way every JSON route is (same site, JSON only, small, once); the test button is
// limited; and the workspace of the address is the only one that is ever touched.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createWorkspacesRepository } from "../../src/db/repositories/workspaces-repository.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { KEY_TEST_WORKSPACE_MAX } from "../../src/llm/key-test.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import type { WorkspaceRole } from "../../src/workspaces/roles.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "sk-or-v1-dummy-fedcba9876543210fedcba9876543210";
const KEY_OF_BETA = "sk-or-v1-sentinel-key-of-beta-9999999999";
const APP_SECRET = "llm-route-test-secret-0123456789-0123456789";

const fakes: FakeLlm[] = [];
const logged: string[] = [];

type Route = typeof import("../../src/app/api/w/[workspace]/llm-key/route.ts");
type TestRoute =
  typeof import("../../src/app/api/w/[workspace]/llm-key/test/route.ts");

async function start() {
  const fake = await startLlmFake();
  fakes.push(fake);
  vi.stubEnv("APP_SECRET", APP_SECRET);
  vi.stubEnv("LLM_API_BASE_URL", fake.baseUrl);
  vi.stubEnv("ALLOW_TEST_LLM_ENDPOINTS", "true");
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  vi.resetModules();
  const db = getDatabase();
  const workspaces = createWorkspacesRepository(db);
  const alpha = await workspaces.create({
    name: "Alpha",
    slug: "alpha",
    createdBy: null,
  });
  const beta = await workspaces.create({
    name: "Beta",
    slug: "beta",
    createdBy: null,
  });
  const people: Record<WorkspaceRole, SessionLookup> = {
    owner: await signedInMember(db, {
      id: "owner-alpha",
      workspaceId: alpha.id,
      role: "owner",
    }),
    admin: await signedInMember(db, {
      id: "admin-alpha",
      workspaceId: alpha.id,
      role: "admin",
    }),
    member: await signedInMember(db, {
      id: "member-alpha",
      workspaceId: alpha.id,
      role: "member",
    }),
  };
  const route =
    (await import("../../src/app/api/w/[workspace]/llm-key/route.ts")) as Route;
  const testRoute =
    (await import("../../src/app/api/w/[workspace]/llm-key/test/route.ts")) as TestRoute;

  const request = (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
    path = "/llm-key",
    slug = "alpha",
  ) =>
    new Request(`https://app.test/api/w/${slug}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const context = (slug = "alpha") => ({
    params: Promise.resolve({ workspace: slug }),
  });
  const as = (role: WorkspaceRole) =>
    session.currentLookup.mockResolvedValue(people[role]);
  const handle = {
    get: (slug = "alpha") =>
      route.GET(request("GET", undefined, {}, "/llm-key", slug), context(slug)),
    put: (
      body: unknown,
      headers: Record<string, string> = {},
      slug = "alpha",
    ) =>
      route.PUT(request("PUT", body, headers, "/llm-key", slug), context(slug)),
    delete: (headers: Record<string, string> = {}) =>
      route.DELETE(request("DELETE", undefined, headers), context()),
    test: (body: unknown = {}, headers: Record<string, string> = {}) =>
      testRoute.POST(
        request("POST", body, headers, "/llm-key/test"),
        context(),
      ),
  };
  const secrets = (workspaceId: string) =>
    db
      .selectFrom("workspace_secrets")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .execute();
  return { fake, db, alpha, beta, as, handle, secrets };
}

beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

/** Everything a test saw of a key, anywhere: answers, rows, logs. */
function expectNoKey(text: string, ...keys: string[]) {
  for (const key of keys) {
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(0, -4));
  }
}

describe("setting the key as an Admin or an Owner", () => {
  // #104-LK-03
  it.each(["admin", "owner"] as const)(
    "saves the key for %s, encrypted, and answers with its last four characters only",
    async (role) => {
      const t = await start();
      t.as(role);

      const response = await t.handle.put({
        provider: "openrouter",
        apiKey: KEY,
      });
      const text = await response.text();

      expect(response.status, text).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.parse(text)).toEqual({
        ok: true,
        changed: true,
        key: {
          state: "configured",
          provider: "openrouter",
          lastFour: KEY.slice(-4),
          updatedAt: expect.any(String),
          updatedBy: `${role}-alpha`,
        },
      });
      const rows = await t.secrets(t.alpha.id);
      expect(rows).toHaveLength(1);
      expectNoKey(`${text}${JSON.stringify(rows)}`, KEY);
    },
  );

  // #104-LK-03
  it("shows an Admin whether a key is configured and its last four characters, never the key", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });

    const response = await t.handle.get();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      canManage: true,
      key: { state: "configured", lastFour: KEY.slice(-4) },
    });
    expectNoKey(text, KEY);
  });

  // #104-LK-03
  it("keeps the stored key when the field is empty and replaces it when a new one is entered", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });

    const kept = await t.handle.put({ provider: "openrouter", apiKey: "" });
    const stillThere = await t.handle.put({ provider: "openrouter" });
    const replaced = await t.handle.put({
      provider: "openrouter",
      apiKey: OTHER_KEY,
    });

    expect((await kept.json()).changed).toBe(false);
    expect((await stillThere.json()).changed).toBe(false);
    expect((await replaced.json()).key.lastFour).toBe(OTHER_KEY.slice(-4));
    expect(await t.secrets(t.alpha.id)).toHaveLength(1);
  });

  // #104-LK-02
  it.each([
    [
      "whitespace inside",
      { provider: "openrouter", apiKey: "sk or v1" },
      "apiKey",
      "api_key_invalid",
    ],
    [
      "no key to keep",
      { provider: "openrouter", apiKey: "" },
      "apiKey",
      "api_key_required",
    ],
    [
      "an unknown provider",
      { provider: "elsewhere", apiKey: KEY },
      "provider",
      "provider_invalid",
    ],
    [
      "more than 4096 characters",
      { provider: "openrouter", apiKey: "k".repeat(4097) },
      "apiKey",
      "api_key_invalid",
    ],
  ])(
    "refuses %s with a stable code and stores nothing",
    async (_n, body, field, code) => {
      const t = await start();
      t.as("admin");

      const response = await t.handle.put(body);
      const text = await response.text();

      expect(response.status).toBe(422);
      expect(JSON.parse(text)).toEqual({
        error: "invalid_input",
        issues: [{ field, code }],
      });
      expect(await t.secrets(t.alpha.id)).toEqual([]);
      expect(text).not.toContain("sk or v1");
    },
  );

  // #104-LK-08
  it("removes the key", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });

    const removed = await t.handle.delete();
    const again = await t.handle.delete();

    expect(await removed.json()).toEqual({ ok: true, removed: true });
    expect(await again.json()).toEqual({ ok: true, removed: false });
    expect(await t.secrets(t.alpha.id)).toEqual([]);
    const state = await (await t.handle.get()).json();
    expect(state.key).toEqual({ state: "not_configured" });
  });

  it("reports a key that cannot be read, and an Admin can replace it", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    await t.db
      .updateTable("workspace_secrets")
      .set({ nonce: "AAAA" })
      .execute();

    const state = await (await t.handle.get()).json();
    const empty = await t.handle.put({ provider: "openrouter", apiKey: "" });
    const replaced = await t.handle.put({
      provider: "openrouter",
      apiKey: OTHER_KEY,
    });

    expect(state.key.state).toBe("unreadable");
    expect(empty.status).toBe(422);
    expect(replaced.status).toBe(200);
  });
});

describe("a Member", () => {
  // #104-LK-04
  it("sees only whether a key exists", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    t.as("member");

    const response = await t.handle.get();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      canManage: false,
      key: { state: "configured" },
    });
    expectNoKey(text, KEY);
    expect(text).not.toContain(KEY.slice(-4));
    expect(text).not.toContain("admin-alpha");
  });

  // #104-LK-04
  it("is refused when setting, removing and testing the key, and nothing changes", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    const before = await t.secrets(t.alpha.id);
    t.as("member");

    const answers = [
      await t.handle.put({ provider: "openrouter", apiKey: OTHER_KEY }),
      await t.handle.delete(),
      await t.handle.test({ apiKey: OTHER_KEY }),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(403);
      expect(await answer.json()).toEqual({ error: "forbidden" });
    }
    expect(await t.secrets(t.alpha.id)).toEqual(before);
    expect(t.fake.keyChecks()).toEqual([]);
  });
});

describe("another workspace", () => {
  // #104-LK-05
  it("is never touched, and never shown, by a change in this one", async () => {
    const t = await start();
    // Beta has a key of its own (stored directly: nobody in alpha belongs to beta).
    const { createWorkspaceLlm } = await import("../../src/llm/assemble.ts");
    await createWorkspaceLlm({
      db: t.db,
      appSecret: () => APP_SECRET,
      env: () => ({}),
    })
      .keyServiceFor(t.beta.id)
      .save({ provider: "openrouter", apiKey: KEY_OF_BETA }, null);
    const beforeBeta = await t.secrets(t.beta.id);
    t.as("owner");

    const put = await t.handle.put({ provider: "openrouter", apiKey: KEY });
    const get = await t.handle.get();
    const removed = await t.handle.delete();
    const foreign = await t.handle.get("beta");
    const foreignPut = await t.handle.put(
      { provider: "openrouter", apiKey: KEY },
      {},
      "beta",
    );

    for (const answer of [put, get, removed])
      expectNoKey(await answer.text(), KEY_OF_BETA);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "not_found" });
    expect(foreignPut.status).toBe(404);
    expect(await t.secrets(t.beta.id)).toEqual(beforeBeta);
  });
});

describe("reading the request", () => {
  // #104-LK-04
  it("refuses a request from another site, a body that is not JSON, one that is too large and one that is no object", async () => {
    const t = await start();
    t.as("admin");
    const body = { provider: "openrouter", apiKey: KEY };

    const crossSite = await t.handle.put(body, {
      "sec-fetch-site": "cross-site",
    });
    const crossSiteDelete = await t.handle.delete({
      "sec-fetch-site": "cross-site",
    });
    const form = await t.handle.put(`apiKey=${KEY}`, {
      "content-type": "application/x-www-form-urlencoded",
    });
    const large = await t.handle.put({
      provider: "openrouter",
      apiKey: "k".repeat(40_000),
    });
    const notAnObject = await t.handle.put("[1,2]");
    const broken = await t.handle.put("{not json");

    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross_site_request" });
    expect(crossSiteDelete.status).toBe(403);
    expect(form.status).toBe(415);
    expect(large.status).toBe(413);
    expect(notAnObject.status).toBe(422);
    expect(broken.status).toBe(422);
    expect(await t.secrets(t.alpha.id)).toEqual([]);
  });

  it("reads a JSON body once and uses the same values for the check and the save", async () => {
    const t = await start();
    t.as("admin");
    // A duplicate field is read like every JSON parser reads it: the last one wins, for the check and the save.
    const response = await t.handle.put(
      `{"provider":"openrouter","apiKey":"sk or v1","apiKey":"${KEY}"}`,
    );

    expect(response.status).toBe(200);
    const stored = await (await t.handle.get()).json();
    expect(stored.key.lastFour).toBe(KEY.slice(-4));
  });
});

describe("the test button", () => {
  // #104-LK-09
  it("succeeds for an accepted key, with the stored key when the field is empty", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    t.fake.acceptKeys([KEY]);

    const response = await t.handle.test({});

    expect(await response.json()).toEqual({ ok: true });
    expect(t.fake.keyChecks()).toEqual([`Bearer ${KEY}`]);
  });

  // #104-LK-09
  it("checks a typed key without storing it", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    t.fake.acceptKeys([OTHER_KEY]);

    const typed = await t.handle.test({ apiKey: OTHER_KEY });
    const stored = await t.handle.test({});

    expect(await typed.json()).toEqual({ ok: true });
    expect(await stored.json()).toMatchObject({
      ok: false,
      error: "llm_key_rejected",
    });
    expect((await (await t.handle.get()).json()).key.lastFour).toBe(
      KEY.slice(-4),
    );
  });

  // #104-LK-09, #104-LK-11
  it("reports a rejected key without the key in the answer or the log, even when the provider quotes it", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    t.fake.acceptKeys([]);
    t.fake.quoteKeyInErrors(true);

    const response = await t.handle.test({});
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: "llm_key_rejected",
    });
    expectNoKey(`${text}\n${logged.join("\n")}`, KEY);
    expect(logged.join("\n")).toContain("KEY_TEST_FAILED: llm_key_rejected");
  });

  // #104-LK-09
  it("reports a provider that cannot be reached as llm_unreachable", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    // Closed here, so it is not closed again after the test.
    fakes.splice(fakes.indexOf(t.fake), 1);
    await t.fake.close();

    const response = await t.handle.test({});

    expect(await response.json()).toEqual({
      ok: false,
      error: "llm_unreachable",
      detail: null,
    });
  });

  // #104-LK-09
  it("does not send a stored key that was entered for another provider", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    await t.db
      .updateTable("workspace_secrets")
      .set({ binding: "another-provider" })
      .execute();

    const response = await t.handle.test({});

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });
    expect(t.fake.keyChecks()).toEqual([]);
  });

  it("asks for a key when none is typed and none is stored", async () => {
    const t = await start();
    t.as("admin");

    const response = await t.handle.test({});

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });
    expect(t.fake.keyChecks()).toEqual([]);
  });

  // #104-LK-09
  it("is limited per workspace, with Retry-After, and the limited click reaches no provider", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    for (let i = 0; i < KEY_TEST_WORKSPACE_MAX; i += 1)
      expect((await t.handle.test({})).status).toBe(200);

    const limited = await t.handle.test({});

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(t.fake.keyChecks()).toHaveLength(KEY_TEST_WORKSPACE_MAX);
  });

  it("does not send a typed key that is no valid key anywhere", async () => {
    const t = await start();
    t.as("admin");

    const response = await t.handle.test({ apiKey: "has a space" });

    expect(response.status).toBe(422);
    expect(t.fake.keyChecks()).toEqual([]);
  });
});

describe("nothing leaves the server but the key's check", () => {
  // #104-LK-11
  it("keeps the key out of every log line while it is saved, tested, rejected and removed", async () => {
    const t = await start();
    t.as("admin");

    await t.handle.put({ provider: "openrouter", apiKey: KEY });
    await t.handle.put({ provider: "openrouter", apiKey: "bad key" });
    await t.handle.test({});
    t.fake.acceptKeys([]);
    t.fake.quoteKeyInErrors(true);
    await t.handle.test({});
    await t.handle.delete();

    expectNoKey(logged.join("\n"), KEY);
  });
});
