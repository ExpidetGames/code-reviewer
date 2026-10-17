// SPDX-License-Identifier: Apache-2.0

// The per-provider routes of the LLM keys of a workspace, `/api/w/:workspace/llm-keys/:provider` (#426), through
// the real route files with the wiring the running server uses. The old `/llm-key` routes stay as an alias for
// the default provider and are pinned down by llm-key-route.integration.test.ts; here: the new routes by role
// and workspace, the alias beside them, the shared limit of the test button and that no key is ever shown.
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
import { LlmAccessSection } from "../../src/llm/ui/llm-access-section.tsx";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import type { WorkspaceRole } from "../../src/workspaces/roles.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// The key form is a client component that reads the router; the page is rendered outside of Next.js here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "sk-or-v1-dummy-fedcba9876543210fedcba9876543210";
const KEY_OF_BETA = "sk-or-v1-sentinel-key-of-beta-9999999999";
const APP_SECRET = "llm-keys-route-test-secret-0123456789-0123";

const fakes: FakeLlm[] = [];
const logged: string[] = [];

type KeysRoute =
  typeof import("../../src/app/api/w/[workspace]/llm-keys/[provider]/route.ts");
type KeysTestRoute =
  typeof import("../../src/app/api/w/[workspace]/llm-keys/[provider]/test/route.ts");
type AliasRoute =
  typeof import("../../src/app/api/w/[workspace]/llm-key/route.ts");
type AliasTestRoute =
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
    (await import("../../src/app/api/w/[workspace]/llm-keys/[provider]/route.ts")) as KeysRoute;
  const testRoute =
    (await import("../../src/app/api/w/[workspace]/llm-keys/[provider]/test/route.ts")) as KeysTestRoute;
  const alias =
    (await import("../../src/app/api/w/[workspace]/llm-key/route.ts")) as AliasRoute;
  const aliasTest =
    (await import("../../src/app/api/w/[workspace]/llm-key/test/route.ts")) as AliasTestRoute;

  const request = (
    method: string,
    path: string,
    body?: unknown,
    slug = "alpha",
  ) =>
    new Request(`https://app.test/api/w/${slug}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const context = (provider: string, slug = "alpha") => ({
    params: Promise.resolve({ workspace: slug, provider }),
  });
  const aliasContext = (slug = "alpha") => ({
    params: Promise.resolve({ workspace: slug }),
  });
  const as = (role: WorkspaceRole) =>
    session.currentLookup.mockResolvedValue(people[role]);
  const handle = {
    get: (provider = "openrouter", slug = "alpha") =>
      route.GET(
        request("GET", `/llm-keys/${provider}`, undefined, slug),
        context(provider, slug),
      ),
    put: (body: unknown, provider = "openrouter", slug = "alpha") =>
      route.PUT(
        request("PUT", `/llm-keys/${provider}`, body, slug),
        context(provider, slug),
      ),
    delete: (provider = "openrouter", slug = "alpha") =>
      route.DELETE(
        request("DELETE", `/llm-keys/${provider}`, undefined, slug),
        context(provider, slug),
      ),
    test: (body: unknown = {}, provider = "openrouter") =>
      testRoute.POST(
        request("POST", `/llm-keys/${provider}/test`, body),
        context(provider),
      ),
    alias: {
      get: () => alias.GET(request("GET", "/llm-key"), aliasContext()),
      put: (body: unknown) =>
        alias.PUT(request("PUT", "/llm-key", body), aliasContext()),
      delete: () => alias.DELETE(request("DELETE", "/llm-key"), aliasContext()),
      test: (body: unknown = {}) =>
        aliasTest.POST(request("POST", "/llm-key/test", body), aliasContext()),
    },
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

function expectNoKey(text: string, ...keys: string[]) {
  for (const key of keys) {
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(0, -4));
  }
}

describe("the key of one provider as an Admin or an Owner", () => {
  // #426-T04
  it.each(["admin", "owner"] as const)(
    "is saved, read, replaced and removed by %s, with the last four characters only",
    async (role) => {
      const t = await start();
      t.as(role);

      const saved = await t.handle.put({ apiKey: KEY });
      const savedText = await saved.text();

      expect(saved.status, savedText).toBe(200);
      expect(saved.headers.get("cache-control")).toBe("no-store");
      expect(JSON.parse(savedText)).toEqual({
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
      const read = await (await t.handle.get()).json();
      expect(read).toMatchObject({
        canManage: true,
        key: { state: "configured", lastFour: KEY.slice(-4) },
      });

      const replaced = await t.handle.put({ apiKey: OTHER_KEY });
      expect(await replaced.json()).toMatchObject({ changed: true });
      const kept = await t.handle.put({ apiKey: "" });
      expect(await kept.json()).toMatchObject({ ok: true, changed: false });

      const removed = await t.handle.delete();
      expect(await removed.json()).toEqual({ ok: true, removed: true });
      expect((await (await t.handle.get()).json()).key).toEqual({
        state: "not_configured",
      });
      expect(await t.secrets(t.alpha.id)).toEqual([]);
    },
  );

  // #426-T04
  it("refuses a body that names another provider than the address, and a field problem has a stable code", async () => {
    const t = await start();
    t.as("admin");

    const other = await t.handle.put({ provider: "elsewhere", apiKey: KEY });
    const bad = await t.handle.put({ apiKey: "has a space" });
    const missing = await t.handle.put({});

    expect(other.status).toBe(422);
    expect(await other.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "provider", code: "provider_invalid" }],
    });
    expect(await bad.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_invalid" }],
    });
    expect(await missing.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });
    expect(await t.secrets(t.alpha.id)).toEqual([]);
  });

  // #426-T04
  it("answers 404 provider_not_found for a provider that is not registered, on every method", async () => {
    const t = await start();
    t.as("admin");

    const answers = [
      await t.handle.get("elsewhere"),
      await t.handle.put({ apiKey: KEY }, "elsewhere"),
      await t.handle.delete("elsewhere"),
      await t.handle.test({}, "elsewhere"),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "provider_not_found" });
    }
    expect(await t.secrets(t.alpha.id)).toEqual([]);
    expect(t.fake.keyChecks()).toEqual([]);
  });
});

describe("a Member", () => {
  // #426-T04
  it("sees only whether a key exists, and is refused everything else", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ apiKey: KEY });
    const before = await t.secrets(t.alpha.id);
    t.as("member");

    const read = await (await t.handle.get()).json();
    const answers = [
      await t.handle.put({ apiKey: OTHER_KEY }),
      await t.handle.delete(),
      await t.handle.test({ apiKey: OTHER_KEY }),
    ];

    expect(read).toEqual({ canManage: false, key: { state: "configured" } });
    for (const answer of answers) {
      expect(answer.status).toBe(403);
      expect(await answer.json()).toEqual({ error: "forbidden" });
    }
    expect(await t.secrets(t.alpha.id)).toEqual(before);
    expect(t.fake.keyChecks()).toEqual([]);
  });
});

describe("a foreign workspace", () => {
  // #426-T04
  it("gets the answer of a workspace that does not exist, and nothing of it is touched", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ apiKey: KEY });
    const { createWorkspaceLlm } = await import("../../src/llm/assemble.ts");
    await createWorkspaceLlm({
      db: t.db,
      appSecret: () => APP_SECRET,
      env: () => ({}),
    })
      .keyServiceFor(t.beta.id)
      .save({ provider: "openrouter", apiKey: KEY_OF_BETA }, null);
    const beforeBeta = await t.secrets(t.beta.id);

    const foreign = [
      await t.handle.get("openrouter", "beta"),
      await t.handle.put({ apiKey: OTHER_KEY }, "openrouter", "beta"),
      await t.handle.delete("openrouter", "beta"),
    ];
    const missing = await t.handle.get("openrouter", "no-such-workspace");

    for (const answer of foreign) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "not_found" });
    }
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(await t.secrets(t.beta.id)).toEqual(beforeBeta);
    expect((await t.secrets(t.alpha.id)).length).toBe(1);
  });
});

describe("the old route beside the new one", () => {
  // #426-T06
  it("is the default provider's key: what one saves the other reads and removes", async () => {
    const t = await start();
    t.as("admin");

    await t.handle.alias.put({ provider: "openrouter", apiKey: KEY });
    const seenByNew = await (await t.handle.get()).json();
    await t.handle.put({ apiKey: OTHER_KEY });
    const seenByAlias = await (await t.handle.alias.get()).json();
    const removed = await t.handle.alias.delete();
    const gone = await (await t.handle.get()).json();

    expect(seenByNew.key).toMatchObject({
      state: "configured",
      provider: "openrouter",
      lastFour: KEY.slice(-4),
    });
    expect(seenByAlias.key).toMatchObject({
      state: "configured",
      lastFour: OTHER_KEY.slice(-4),
    });
    expect(await removed.json()).toEqual({ ok: true, removed: true });
    expect(gone.key).toEqual({ state: "not_configured" });
  });

  // #426-T06
  it("keeps refusing a provider that is not registered", async () => {
    const t = await start();
    t.as("admin");

    const answer = await t.handle.alias.put({
      provider: "elsewhere",
      apiKey: KEY,
    });

    expect(answer.status).toBe(422);
    expect(await answer.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "provider", code: "provider_invalid" }],
    });
  });
});

describe("the test button", () => {
  // #426-T01
  it("checks the stored key of the provider in the address, or a typed key", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ apiKey: KEY });
    t.fake.acceptKeys([KEY]);

    const stored = await t.handle.test({});
    t.fake.acceptKeys([OTHER_KEY]);
    const typed = await t.handle.test({ apiKey: OTHER_KEY });

    expect(await stored.json()).toEqual({ ok: true });
    expect(await typed.json()).toEqual({ ok: true });
    expect(t.fake.keyChecks()).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${OTHER_KEY}`,
    ]);
  });

  // #426-T09
  it("is limited per workspace, whichever of the routes asks", async () => {
    const t = await start();
    t.as("admin");
    await t.handle.put({ apiKey: KEY });
    for (let i = 0; i < KEY_TEST_WORKSPACE_MAX - 1; i += 1)
      expect((await t.handle.test({})).status).toBe(200);
    expect((await t.handle.alias.test({})).status).toBe(200);

    const viaNew = await t.handle.test({});
    const viaAlias = await t.handle.alias.test({});

    for (const limited of [viaNew, viaAlias]) {
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await limited.json()).toEqual({ error: "rate_limited" });
    }
    expect(t.fake.keyChecks()).toHaveLength(KEY_TEST_WORKSPACE_MAX);
  });
});

describe("what is shown", () => {
  // #426-T05
  it("holds no key in any answer, log line or page while keys are saved, tested, rejected and removed", async () => {
    const t = await start();
    t.as("admin");
    const answers: string[] = [];
    const take = async (response: Response) => {
      answers.push(await response.text());
    };

    await take(await t.handle.put({ apiKey: KEY }));
    await take(await t.handle.put({ apiKey: "bad key" }));
    await take(await t.handle.get());
    t.fake.acceptKeys([]);
    t.fake.quoteKeyInErrors(true);
    await take(await t.handle.test({}));
    await take(await t.handle.test({ apiKey: OTHER_KEY }));
    const { getWorkspaceLlm } = await import("../../src/llm/shared.ts");
    const llm = getWorkspaceLlm();
    const page = renderToStaticMarkup(
      createElement(LlmAccessSection, {
        workspaceSlug: "alpha",
        canManage: true,
        keyStatuses: await llm.keyServiceFor(t.alpha.id).statusAll(),
        summary: await llm.summaryFor(t.alpha.id),
      }),
    );
    await take(await t.handle.delete());

    expectNoKey(
      `${answers.join("\n")}\n${logged.join("\n")}\n${page}`,
      KEY,
      OTHER_KEY,
    );
  });
});
