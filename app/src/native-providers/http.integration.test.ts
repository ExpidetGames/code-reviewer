// SPDX-License-Identifier: Apache-2.0

// The handlers of the key routes for a catalog provider (#555), over a real database with a stub catalog and key tester: a
// supported provider that is offered carries a key and is tested; one that is blocked, excluded or unknown answers 404
// provider_not_found for a save and a test, and a key can still be read and removed for a provider that was blocked later.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createLlmKeyRouteHandlers } from "../llm/http.ts";
import type { LlmKeyTestService } from "../llm/key-test.ts";
import { createWorkspaceLlmKeyService } from "../llm/workspace-key.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { withNativeProviders } from "./lookup.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";

const APP_SECRET = "native-http-test-app-secret-0123456789-0123456";
const KEY = "sk-deepseek-dummy-0123456789abcdef0123456789abcdef";

async function setup(offered: readonly string[] = ["deepseek"], moved = false) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "alpha");
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('user-1', 'Owner', 'owner@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const keys = createWorkspaceLlmKeyService({
    store: createWorkspaceSecretStore({
      db,
      workspaceId,
      appSecret: APP_SECRET,
    }),
    providers: withNativeProviders(llmProviderDescriptors),
  });
  const tested: Array<{ provider: string; apiKey: string }> = [];
  const preflighted: string[] = [];
  const tester: LlmKeyTestService = {
    preflight: ({ provider }) => {
      preflighted.push(provider);
      return Promise.resolve(
        moved
          ? ({
              ok: false,
              error: "llm_provider_address_changed",
              detail: null,
            } as const)
          : null,
      );
    },
    test: ({ provider, apiKey }) => {
      tested.push({ provider, apiKey });
      return Promise.resolve({ ok: true, verified: false });
    },
  };
  // The key service as the route sees it, counting the times a stored key is decrypted.
  const revealed: string[] = [];
  const spied: typeof keys = {
    ...keys,
    reveal: (provider) => {
      revealed.push(provider);
      return keys.reveal(provider);
    },
  };
  const handlers = createLlmKeyRouteHandlers({
    keys: spied,
    tester,
    catalog: {
      providerAvailable: (slug) => Promise.resolve(offered.includes(slug)),
    },
  });
  const access = (role: "owner" | "member"): WorkspaceAccess =>
    ({
      role,
      user: { id: "user-1" },
      workspace: { id: workspaceId, slug: "alpha", name: "Alpha" },
    }) as unknown as WorkspaceAccess;
  const request = (method: string, body?: unknown) =>
    new Request("https://app.test/api/w/alpha/llm-keys/x", {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { handlers, access, request, keys, tested, revealed, preflighted };
}

describe("the key routes for a catalog provider", () => {
  // #555-T02
  it("save, read and remove the key of an offered provider, and show the last four characters to an owner only", async () => {
    const t = await setup();

    const saved = await t.handlers.put(
      t.request("PUT", { apiKey: KEY }),
      t.access("owner"),
      "deepseek",
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      changed: true,
      key: { state: "configured", provider: "deepseek", lastFour: "cdef" },
    });
    const asMember = await t.handlers.get(
      t.request("GET"),
      t.access("member"),
      "deepseek",
    );
    expect(await asMember.json()).toEqual({
      canManage: false,
      key: { state: "configured" },
    });
    const removed = await t.handlers.remove(
      t.request("DELETE"),
      t.access("owner"),
      "deepseek",
    );
    expect(await removed.json()).toEqual({ ok: true, removed: true });
  });

  // #555-T02
  it("refuse a member, and never put the key into an answer", async () => {
    const t = await setup();

    const refused = await t.handlers.put(
      t.request("PUT", { apiKey: KEY }),
      t.access("member"),
      "deepseek",
    );

    expect(refused.status).toBe(403);
    expect(await t.keys.status("deepseek")).toEqual({
      state: "not_configured",
    });
    const saved = await t.handlers.put(
      t.request("PUT", { apiKey: KEY }),
      t.access("owner"),
      "deepseek",
    );
    expect(JSON.stringify(await saved.json())).not.toContain(KEY);
  });

  // #555-T01
  it("answer 404 provider_not_found for a save and a test of a provider that is blocked, excluded or unknown, with nothing saved", async () => {
    const t = await setup(["deepseek"]);

    for (const provider of ["google", "amazon_bedrock", "nosuchprovider"]) {
      const put = await t.handlers.put(
        t.request("PUT", { apiKey: KEY }),
        t.access("owner"),
        provider,
      );
      const test = await t.handlers.test(
        t.request("POST", { apiKey: KEY }),
        t.access("owner"),
        provider,
      );
      expect(put.status).toBe(404);
      expect(await put.json()).toEqual({ error: "provider_not_found" });
      expect(test.status).toBe(404);
    }
    expect(t.tested).toEqual([]);
  });

  // #555-T01
  it("still read and remove the key of a provider that is blocked now: a key can always be taken back", async () => {
    const t = await setup(["deepseek"]);
    await t.keys.save({ provider: "openai", apiKey: KEY }, null);

    const read = await t.handlers.get(
      t.request("GET"),
      t.access("owner"),
      "openai",
    );
    const removed = await t.handlers.remove(
      t.request("DELETE"),
      t.access("owner"),
      "openai",
    );

    expect(await read.json()).toMatchObject({ key: { state: "configured" } });
    expect(await removed.json()).toEqual({ ok: true, removed: true });
  });

  // #555-T02
  it("test the typed key at the catalog provider, or the stored one when the field is empty; not verified is an ok", async () => {
    const t = await setup();
    await t.keys.save({ provider: "deepseek", apiKey: KEY }, null);

    const typed = await t.handlers.test(
      t.request("POST", { apiKey: `${KEY}-typed` }),
      t.access("owner"),
      "deepseek",
    );
    const stored = await t.handlers.test(
      t.request("POST", { apiKey: "" }),
      t.access("owner"),
      "deepseek",
    );

    expect(await typed.json()).toEqual({ ok: true, verified: false });
    expect(await stored.json()).toEqual({ ok: true, verified: false });
    expect(t.tested).toEqual([
      { provider: "deepseek", apiKey: `${KEY}-typed` },
      { provider: "deepseek", apiKey: KEY },
    ]);
  });

  // #588-T47
  it("refuse the test of a provider whose address moved before the stored key is decrypted, for a typed key too", async () => {
    const t = await setup(["deepseek"], true);
    await t.keys.save({ provider: "deepseek", apiKey: KEY }, null);

    const stored = await t.handlers.test(
      t.request("POST", {}),
      t.access("owner"),
      "deepseek",
    );
    const typed = await t.handlers.test(
      t.request("POST", { apiKey: `${KEY}-typed` }),
      t.access("owner"),
      "deepseek",
    );

    for (const response of [stored, typed]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: false,
        error: "llm_provider_address_changed",
        detail: null,
      });
    }
    expect(t.preflighted).toEqual(["deepseek", "deepseek"]);
    expect(t.revealed).toEqual([]);
    expect(t.tested).toEqual([]);
  });

  // #588-T47
  it("decrypts the stored key for a test only after the address check passed", async () => {
    const t = await setup(["deepseek"], false);
    await t.keys.save({ provider: "deepseek", apiKey: KEY }, null);

    await t.handlers.test(t.request("POST", {}), t.access("owner"), "deepseek");

    expect(t.preflighted).toEqual(["deepseek"]);
    expect(t.revealed).toEqual(["deepseek"]);
    expect(t.tested).toEqual([{ provider: "deepseek", apiKey: KEY }]);
  });

  // #555-T02
  it("refuse a body that names another provider than the address", async () => {
    const t = await setup();

    const other = await t.handlers.put(
      t.request("PUT", { provider: "openai", apiKey: KEY }),
      t.access("owner"),
      "deepseek",
    );

    expect(other.status).toBe(422);
    expect(await other.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "provider", code: "provider_invalid" }],
    });
  });
});
