// SPDX-License-Identifier: Apache-2.0

// The operator's own LLM key in the admin portal (#276), end to end over a real database, the real proxy and the
// real data route: only an instance admin saves or removes it, it is write-only (the settings carry the status
// and the last four characters, nothing else), it is stored encrypted, and it is in no answer, page or log line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { OPERATOR_KEY_TEST_ADMIN_MAX } from "../llm/operator-key-test.ts";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import {
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { SETUP_TEST_SECRET } from "../test-support/setup-harness.ts";

const KEY = "sk-or-v1-operator-key-0123456789abcdef-wxyz";
const OTHER_KEY = "sk-or-v1-operator-key-fedcba9876543210-abcd";
const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };

function put(
  portal: AdminHarness,
  body: unknown,
  cookies = portal.adminCookies,
) {
  return portal.visit("/api/admin/settings", { method: "PUT", body, cookies });
}

async function statusOf(portal: AdminHarness) {
  const read = await portal.visit("/api/admin/settings", {
    cookies: portal.adminCookies,
  });
  return (await read.json()) as {
    operatorLlmKey: Record<string, unknown>;
    operatorLlmKeys: Record<string, Record<string, unknown>>;
    secrets: Array<Record<string, unknown>>;
  };
}

/** What the resolver would get, with the master key of the harness. */
function operatorKeyOf(portal: AdminHarness) {
  return createWorkspaceLlm({
    db: portal.db,
    appSecret: () => SETUP_TEST_SECRET,
    env: () => ({}),
  })
    .operatorKey()
    .forJob(DEFAULT_LLM_PROVIDER);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saving the operator's key", () => {
  // #276-T06
  it("stores it encrypted, and every answer carries the status and the last four characters only", async () => {
    const portal = await createAdminHarness();
    expect(await statusOf(portal)).toMatchObject({
      operatorLlmKey: { state: "not_configured" },
    });

    const response = await put(portal, { operatorLlmKey: { apiKey: KEY } });
    const answer = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(answer).not.toContain(KEY);
    expect(answer).not.toContain(KEY.slice(0, -4));
    expect(JSON.parse(answer).settings.operatorLlmKey).toMatchObject({
      state: "configured",
      lastFour: "wxyz",
    });
    const read = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    const text = await read.text();
    expect(text).not.toContain(KEY.slice(0, -4));
    expect(JSON.parse(text).secrets).toContainEqual(
      expect.objectContaining({
        name: "operator_llm_key",
        state: "configured",
        lastFour: "wxyz",
      }),
    );
    const stored = await portal.db.selectFrom("secrets").selectAll().execute();
    expect(JSON.stringify(stored)).not.toContain(KEY.slice(0, -4));
    expect(stored.map((row) => row.name)).toContain("operator_llm_key");
    // What the app reads back with its master key is the key.
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });
  });

  // #276-T06
  it("writes the key into no log line, not even while it cannot be read", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const portal = await createAdminHarness();

    await put(portal, { operatorLlmKey: { apiKey: KEY } });
    await put(portal, { operatorLlmKey: { apiKey: "has a space" } });
    await portal.db.updateTable("secrets").set({ nonce: "AAAA" }).execute();
    const broken = await statusOf(portal);

    expect(broken.operatorLlmKey).toMatchObject({ state: "unreadable" });
    expect(JSON.stringify(broken)).not.toContain(KEY.slice(0, -4));
    expect(lines.join("\n")).not.toContain(KEY.slice(0, -4));
    expect(lines.join("\n")).not.toContain("has a space");
  });

  // #276-T06
  it("replaces the key, and removes it with null", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });

    await put(portal, { operatorLlmKey: { apiKey: OTHER_KEY } });
    expect(await operatorKeyOf(portal)).toEqual({
      state: "key",
      apiKey: OTHER_KEY,
    });
    expect((await statusOf(portal)).operatorLlmKey).toMatchObject({
      lastFour: "abcd",
    });

    const removed = await put(portal, { operatorLlmKey: null });

    expect(removed.status).toBe(200);
    expect(await operatorKeyOf(portal)).toEqual({ state: "none" });
    expect((await statusOf(portal)).operatorLlmKey).toEqual({
      state: "not_configured",
    });
    // Removing what is not there is not an error.
    expect((await put(portal, { operatorLlmKey: null })).status).toBe(200);
  });

  // #276-T06
  it("refuses a key that is empty or has a space, and a value that is no key, with the names of the fields and nothing changes", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });

    for (const [body, issues] of [
      [
        { operatorLlmKey: { apiKey: "" } },
        [{ field: "apiKey", code: "api_key_required" }],
      ],
      [{ operatorLlmKey: {} }, [{ field: "apiKey", code: "api_key_required" }]],
      [
        { operatorLlmKey: { apiKey: "with space inside" } },
        [{ field: "apiKey", code: "api_key_invalid" }],
      ],
      [
        { operatorLlmKey: { apiKey: 12345 } },
        [{ field: "apiKey", code: "api_key_invalid" }],
      ],
      [
        { operatorLlmKey: "sk-or-v1-as-a-bare-string-0123456789" },
        [{ field: "operatorLlmKey", code: "operator_llm_key_invalid" }],
      ],
      [
        { operatorLlmKey: ["a"] },
        [{ field: "operatorLlmKey", code: "operator_llm_key_invalid" }],
      ],
    ] as const) {
      const response = await put(portal, body);
      const text = await response.text();

      expect(response.status).toBe(422);
      expect(JSON.parse(text)).toEqual({ error: "invalid_input", issues });
      expect(text).not.toContain("with space inside");
      expect(text).not.toContain("bare-string");
    }
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });
  });

  // #276-T06
  it("refuses a request from another site", async () => {
    const portal = await createAdminHarness();

    const response = await portal.visit("/api/admin/settings", {
      method: "PUT",
      body: { operatorLlmKey: { apiKey: KEY } },
      cookies: portal.adminCookies,
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.test" },
    });

    expect(response.status).toBe(403);
    expect(await operatorKeyOf(portal)).toEqual({ state: "none" });
  });
});

describe("who can read or write the operator's key", () => {
  // #276-T07
  it("is nobody but an instance admin: a person who is not an admin gets the answer of a missing path and nothing changes", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });
    await portal.createUser({ id: "member-1", ...MEMBER });
    const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);
    const before = await portal.db.selectFrom("secrets").selectAll().execute();

    const read = await portal.visit("/api/admin/settings", {
      cookies: memberCookies,
    });
    const write = await put(portal, { operatorLlmKey: null }, memberCookies);
    const overwrite = await put(
      portal,
      { operatorLlmKey: { apiKey: OTHER_KEY } },
      memberCookies,
    );
    const page = await portal.visit("/admin/llm", { cookies: memberCookies });

    for (const response of [read, write, overwrite, page]) {
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).not.toContain(KEY.slice(0, -4));
      expect(text).not.toContain("operator_llm_key");
    }
    expect(await portal.db.selectFrom("secrets").selectAll().execute()).toEqual(
      before,
    );
  });

  // #276-T07
  it.each(["owner", "admin"] as const)(
    "is not the %s of a workspace's to read or write: a person who is not the instance admin gets the answer of a missing path, and nothing changes",
    async (role) => {
      const portal = await createAdminHarness();
      await put(portal, { operatorLlmKey: { apiKey: KEY } });
      await portal.createUser({
        id: `${role}-1`,
        email: `workspace-${role}@example.com`,
        password: MEMBER.password,
        member: false,
      });
      const workspace = await createWorkspacesRepository(
        portal.db,
      ).findDefault();
      if (workspace === undefined) throw new Error("no workspace");
      await createWorkspacesRepository(portal.db).addMember(
        workspace.id,
        `${role}-1`,
        role,
      );
      const cookies = await portal.signIn(
        `workspace-${role}@example.com`,
        MEMBER.password,
      );
      const before = await portal.db
        .selectFrom("secrets")
        .selectAll()
        .execute();

      const read = await portal.visit("/api/admin/settings", { cookies });
      const write = await put(
        portal,
        { operatorLlmKey: { apiKey: OTHER_KEY } },
        cookies,
      );
      const remove = await put(portal, { operatorLlmKey: null }, cookies);
      const page = await portal.visit("/admin/llm", { cookies });

      for (const response of [read, write, remove, page]) {
        expect(response.status).toBe(404);
        const text = await response.text();
        expect(text).not.toContain(KEY.slice(0, -4));
        expect(text).not.toContain(OTHER_KEY);
        expect(text).not.toContain("operator_llm_key");
        expect(text).not.toContain("wxyz");
      }
      expect(
        await portal.db.selectFrom("secrets").selectAll().execute(),
      ).toEqual(before);
      expect(await operatorKeyOf(portal)).toEqual({
        state: "key",
        apiKey: KEY,
      });
    },
  );

  // #276-T07
  it("is not reachable without a session: nobody gets a status, and a bearer token (the operator API's) is no session", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKey: { apiKey: KEY } });

    for (const headers of [
      {} as Record<string, string>,
      { authorization: "Bearer test-operator-token-3b8e1d-6a40f2c97e15" },
      { authorization: "Bearer test-runner-token-4f9c2a7e1b-0d58a3c6e9f2" },
    ]) {
      const read = await portal.visit("/api/admin/settings", { headers });
      const write = await portal.visit("/api/admin/settings", {
        method: "PUT",
        body: { operatorLlmKey: null },
        headers,
      });

      for (const response of [read, write]) {
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain("operator_llm_key");
      }
    }
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });
  });
});

describe("the operator's keys per provider", () => {
  const OPENROUTER = DEFAULT_LLM_PROVIDER;

  // #427-T01
  it("lists the state of the key of every provider in the settings, next to the old field", async () => {
    const portal = await createAdminHarness();
    expect(await statusOf(portal)).toMatchObject({
      operatorLlmKeys: { [OPENROUTER]: { state: "not_configured" } },
    });

    await put(portal, { operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } } });

    const status = await statusOf(portal);
    expect(status.operatorLlmKeys[OPENROUTER]).toMatchObject({
      state: "configured",
      lastFour: "wxyz",
    });
    expect(status.operatorLlmKey).toEqual(status.operatorLlmKeys[OPENROUTER]);
    expect(Object.keys(status.operatorLlmKeys)).toEqual([OPENROUTER]);
  });

  // #427-T01
  it("saves, replaces and removes the key of a provider with { operatorLlmKeys: { <provider>: ... } }", async () => {
    const portal = await createAdminHarness();

    const saved = await put(portal, {
      operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } },
    });
    expect(saved.status).toBe(200);
    expect(
      (await saved.json()).settings.operatorLlmKeys[OPENROUTER],
    ).toMatchObject({ state: "configured", lastFour: "wxyz" });
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });

    await put(portal, {
      operatorLlmKeys: { [OPENROUTER]: { apiKey: OTHER_KEY } },
    });
    expect(await operatorKeyOf(portal)).toEqual({
      state: "key",
      apiKey: OTHER_KEY,
    });

    const removed = await put(portal, {
      operatorLlmKeys: { [OPENROUTER]: null },
    });
    expect(removed.status).toBe(200);
    expect(await operatorKeyOf(portal)).toEqual({ state: "none" });
    expect((await statusOf(portal)).operatorLlmKeys[OPENROUTER]).toEqual({
      state: "not_configured",
    });
  });

  // #427-T06
  it("still accepts { operatorLlmKey } for the default provider, and both shapes act on the same key", async () => {
    const portal = await createAdminHarness();

    await put(portal, { operatorLlmKey: { apiKey: KEY } });
    expect((await statusOf(portal)).operatorLlmKeys[OPENROUTER]).toMatchObject({
      state: "configured",
      lastFour: "wxyz",
    });
    await put(portal, { operatorLlmKeys: { [OPENROUTER]: null } });
    expect(await operatorKeyOf(portal)).toEqual({ state: "none" });
    await put(portal, { operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } } });
    await put(portal, { operatorLlmKey: null });
    expect(await operatorKeyOf(portal)).toEqual({ state: "none" });
  });

  // #427-T01
  it("refuses a provider that is not registered, in any spelling, and more than one provider, and changes nothing", async () => {
    const portal = await createAdminHarness();
    await put(portal, { operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } } });

    for (const [body, issues] of [
      [
        { operatorLlmKeys: { nobody: { apiKey: OTHER_KEY } } },
        [{ field: "provider", code: "provider_invalid" }],
      ],
      [
        { operatorLlmKeys: { OpenRouter: null } },
        [{ field: "provider", code: "provider_invalid" }],
      ],
      [
        { operatorLlmKeys: { [` ${OPENROUTER}`]: null } },
        [{ field: "provider", code: "provider_invalid" }],
      ],
      [
        { operatorLlmKeys: { operator_llm_key: null } },
        [{ field: "provider", code: "provider_invalid" }],
      ],
      [
        { operatorLlmKeys: {} },
        [{ field: "operatorLlmKeys", code: "operator_llm_key_invalid" }],
      ],
      [
        { operatorLlmKeys: [{ apiKey: OTHER_KEY }] },
        [{ field: "operatorLlmKeys", code: "operator_llm_key_invalid" }],
      ],
      [
        { operatorLlmKeys: { [OPENROUTER]: { apiKey: "with space" } } },
        [{ field: "apiKey", code: "api_key_invalid" }],
      ],
      [
        { operatorLlmKeys: { [OPENROUTER]: {} } },
        [{ field: "apiKey", code: "api_key_required" }],
      ],
    ] as const) {
      const response = await put(portal, body);
      const text = await response.text();

      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(JSON.parse(text)).toEqual({ error: "invalid_input", issues });
      expect(text).not.toContain(OTHER_KEY);
    }
    // Neither setting together with the other in one request.
    expect(
      (
        await put(portal, {
          operatorLlmKeys: { [OPENROUTER]: null },
          operatorLlmKey: null,
        })
      ).status,
    ).toBe(422);
    expect(await operatorKeyOf(portal)).toEqual({ state: "key", apiKey: KEY });
  });

  // #427-T07
  it("puts no key into any answer of the settings, and no secret name of a key into the page's data but the status of the secrets", async () => {
    const portal = await createAdminHarness();

    const answers = [
      await (
        await put(portal, {
          operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } },
        })
      ).text(),
      await (
        await portal.visit("/api/admin/settings", {
          cookies: portal.adminCookies,
        })
      ).text(),
      await (
        await put(portal, {
          operatorLlmKeys: { [OPENROUTER]: { apiKey: "has a space" } },
        })
      ).text(),
    ];

    for (const answer of answers) {
      expect(answer).not.toContain(KEY.slice(0, -4));
      expect(answer).not.toContain("has a space");
    }
  });
});

describe("the Test button of the operator's keys", () => {
  const OPENROUTER = DEFAULT_LLM_PROVIDER;
  const test = (
    portal: AdminHarness,
    body: unknown = {},
    provider: string = OPENROUTER,
    cookies = portal.adminCookies,
  ) =>
    portal.visit(`/api/admin/llm-keys/${encodeURIComponent(provider)}/test`, {
      method: "POST",
      body,
      cookies,
    });
  async function start() {
    const llm = await startLlmFake();
    cleanUpAfterTest(() => llm.close());
    return { llm, portal: await createAdminHarness({ llm }) };
  }

  // #427-T01
  it("tests the typed key, or the stored one when the field is empty, and answers with the class of a failure", async () => {
    const { llm, portal } = await start();

    const typed = await test(portal, { apiKey: KEY });
    expect(typed.status).toBe(200);
    expect(await typed.json()).toEqual({ ok: true });
    expect(llm.keyChecks()).toHaveLength(1);

    // Nothing is stored yet: the empty field has nothing to test.
    const missing = await test(portal, { apiKey: "" });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });

    await put(portal, {
      operatorLlmKeys: { [OPENROUTER]: { apiKey: OTHER_KEY } },
    });
    expect(await (await test(portal, {})).json()).toEqual({ ok: true });
    expect(llm.keyChecks()).toHaveLength(2);

    llm.failWith({ status: 401, message: "no" });
    const rejected = await test(portal, { apiKey: KEY });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: "llm_key_rejected",
    });
    const invalid = await test(portal, { apiKey: "has a space" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_invalid" }],
    });
  });

  // #427-T01
  it("tells a saved key that cannot be read from no key at all, for an empty field", async () => {
    const { llm, portal } = await start();
    await put(portal, { operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } } });
    await portal.db.updateTable("secrets").set({ nonce: "AAAA" }).execute();

    const unreadable = await test(portal, {});

    expect(unreadable.status).toBe(422);
    expect(await unreadable.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_unreadable" }],
    });
    // A typed key still works: it is what the admin enters to repair the slot.
    expect((await test(portal, { apiKey: OTHER_KEY })).status).toBe(200);
    expect(llm.keyChecks()).toHaveLength(1);
  });

  // #427-T07
  it("is write-only: no answer holds the key, no log line does, and the headers say no-store", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const { llm, portal } = await start();
    llm.failWith({ status: 401, message: `bad key ${KEY}` });
    await put(portal, {
      operatorLlmKeys: { [OPENROUTER]: { apiKey: OTHER_KEY } },
    });

    const answers = [
      await test(portal, { apiKey: KEY }),
      await test(portal, { apiKey: "has a space" }),
      await test(portal, {}),
    ];

    for (const response of answers) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(OTHER_KEY);
    }
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(OTHER_KEY);
    expect(lines.join("\n")).not.toContain("has a space");
  });

  // #427-T01
  it("is limited per admin with 429 and Retry-After, counted apart from the workspaces' test button", async () => {
    const { llm, portal } = await start();
    for (let i = 0; i < OPERATOR_KEY_TEST_ADMIN_MAX; i += 1)
      expect((await test(portal, { apiKey: KEY })).status).toBe(200);

    const refused = await test(portal, { apiKey: KEY });

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(llm.keyChecks()).toHaveLength(OPERATOR_KEY_TEST_ADMIN_MAX);
    const keys = await portal.db
      .selectFrom("rate_limits")
      .select("key")
      .execute();
    expect(
      keys
        .map((row) => row.key)
        .every((key) => key.startsWith("operator-llm-key-test:")),
    ).toBe(true);
  });

  // #427-T01
  it("answers 404 provider_not_found for a provider that is not registered or not spelled as its id, after the admin was settled", async () => {
    const { llm, portal } = await start();

    for (const provider of [
      "nobody",
      "OpenRouter",
      " openrouter",
      "operator_llm_key",
    ]) {
      const response = await test(portal, { apiKey: KEY }, provider);

      expect(response.status, provider).toBe(404);
      expect(await response.json()).toEqual({ error: "provider_not_found" });
    }
    expect(llm.keyChecks()).toHaveLength(0);
  });

  // #427-T02
  it("is for an instance admin only: a person who is not one gets the answer of a missing path and nothing is tested", async () => {
    const { llm, portal } = await start();
    await put(portal, { operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } } });
    await portal.createUser({ id: "member-1", ...MEMBER });
    const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);

    const asMember = await test(portal, {}, OPENROUTER, memberCookies);
    const anonymous = await portal.visit(
      `/api/admin/llm-keys/${OPENROUTER}/test`,
      {
        method: "POST",
        body: {},
      },
    );

    expect(asMember.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(llm.keyChecks()).toHaveLength(0);
  });

  // #427-T02
  it("is guarded by the handler itself, with no proxy in front: 401 without a session, 404 for a person who is not an admin, and nothing is tested or stored", async () => {
    const { llm, portal } = await start();
    await portal.createUser({ id: "member-1", ...MEMBER });
    const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);
    const path = `/api/instance-portal/llm-keys/${OPENROUTER}/test`;
    const settings = "/api/instance-portal/settings";
    const keyBody = { apiKey: KEY };

    const answers = [
      await portal.callRoute(path, { method: "POST", body: keyBody }),
      await portal.callRoute(path, {
        method: "POST",
        body: keyBody,
        cookies: memberCookies,
      }),
      await portal.callRoute(settings, {
        method: "PUT",
        body: { operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } } },
      }),
      await portal.callRoute(settings, {
        method: "PUT",
        body: { operatorLlmKeys: { [OPENROUTER]: { apiKey: KEY } } },
        cookies: memberCookies,
      }),
    ];

    expect(answers.map((response) => response.status)).toEqual([
      401, 404, 401, 404,
    ]);
    expect(llm.keyChecks()).toHaveLength(0);
    expect(await statusOf(portal)).toMatchObject({
      operatorLlmKeys: { [OPENROUTER]: { state: "not_configured" } },
    });
  });

  // #427-T01
  it("refuses a request from another site, a body that is not JSON and a body that is not an object", async () => {
    const { llm, portal } = await start();

    const crossSite = await portal.visit(
      `/api/admin/llm-keys/${OPENROUTER}/test`,
      {
        method: "POST",
        body: { apiKey: KEY },
        cookies: portal.adminCookies,
        headers: {
          "sec-fetch-site": "cross-site",
          origin: "https://evil.test",
        },
      },
    );
    const notJson = await portal.visit(
      `/api/admin/llm-keys/${OPENROUTER}/test`,
      {
        method: "POST",
        body: "apiKey=x",
        cookies: portal.adminCookies,
        headers: { "content-type": "text/plain" },
      },
    );
    const array = await test(portal, [KEY]);

    expect(crossSite.status).toBe(403);
    expect(notJson.status).toBe(415);
    expect(array.status).toBe(422);
    expect(llm.keyChecks()).toHaveLength(0);
  });
});
