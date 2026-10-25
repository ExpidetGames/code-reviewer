// SPDX-License-Identifier: LicenseRef-Proprietary

// The key of a workspace for a catalog provider (#555), over a real Postgres database: stored and revealed exactly as the key of
// a registry provider, one slot per provider, and a key of one provider is never used for another.
import { describe, expect, it } from "vitest";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { resolveWorkspaceLlmAccess } from "../llm/resolve.ts";
import { createWorkspaceLlmKeyService } from "../llm/workspace-key.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { withNativeProviders } from "./lookup.ts";

const APP_SECRET = "native-keys-test-app-secret-0123456789-012345";
const DEEPSEEK_KEY = "sk-deepseek-dummy-0123456789abcdef0123456789abcdef";
const OPENAI_KEY = "sk-openai-dummy-fedcba9876543210fedcba9876543210";
const ROUTER_KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";
const providers = withNativeProviders(llmProviderDescriptors);

async function start() {
  const { db } = await createTestDatabase();
  const alpha = await addWorkspace(db, "alpha");
  const beta = await addWorkspace(db, "beta");
  const serviceOf = (workspaceId: string) =>
    createWorkspaceLlmKeyService({
      store: createWorkspaceSecretStore({
        db,
        workspaceId,
        appSecret: APP_SECRET,
      }),
      providers,
    });
  return { db, alpha, beta, service: serviceOf(alpha), serviceOf };
}

describe("a key for a catalog provider", () => {
  // #555-T02
  it("is stored encrypted under its own slot, bound to the provider, and reads back as that provider's key only", async () => {
    const { service, db, alpha } = await start();

    const saved = await service.save(
      { provider: "deepseek", apiKey: DEEPSEEK_KEY },
      null,
    );

    expect(saved).toMatchObject({
      ok: true,
      changed: true,
      status: { state: "configured", provider: "deepseek", lastFour: "cdef" },
    });
    expect(await service.keyFor("deepseek")).toEqual({
      state: "key",
      binding: "deepseek",
      apiKey: DEEPSEEK_KEY,
    });
    const rows = await db
      .selectFrom("workspace_secrets")
      .select(["workspace_id", "name", "binding", "ciphertext"])
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: alpha,
      name: "llm_api_key.deepseek",
      binding: "deepseek",
    });
    expect(rows[0]?.ciphertext).not.toContain(DEEPSEEK_KEY);
  });

  // #555-T06
  it("is never the key of another provider: a project of provider A with a key only for provider B has no key", async () => {
    const { service } = await start();
    await service.save({ provider: "openai", apiKey: OPENAI_KEY }, null);

    expect(await service.keyFor("deepseek")).toEqual({ state: "none" });
    // The resolver compares the binding with the provider it asked for: B's key is not handed to A.
    const resolved = resolveWorkspaceLlmAccess(
      {
        keyMode: "own",
        provider: "deepseek",
        key: await service.keyFor("openai"),
        defaults: { model: "m", contextWindowTokens: null },
      },
      providers,
    );
    expect(resolved).toMatchObject({
      ok: false,
      reason: "key_binding_mismatch",
    });
  });

  // #555-T02
  it("keeps the key of the registry's providers and of other catalog providers untouched when one is replaced or removed", async () => {
    const { service } = await start();
    await service.save({ provider: "openrouter", apiKey: ROUTER_KEY }, null);
    await service.save({ provider: "deepseek", apiKey: DEEPSEEK_KEY }, null);
    await service.save({ provider: "openai", apiKey: OPENAI_KEY }, null);

    await service.save(
      { provider: "deepseek", apiKey: `${DEEPSEEK_KEY}-new` },
      null,
    );
    expect(await service.remove("openai")).toBe(true);

    expect(await service.keyFor("openrouter")).toMatchObject({
      apiKey: ROUTER_KEY,
    });
    expect(await service.keyFor("deepseek")).toMatchObject({
      apiKey: `${DEEPSEEK_KEY}-new`,
    });
    expect(await service.keyFor("openai")).toEqual({ state: "none" });
  });

  // #555-T02
  it("is refused for a provider that is excluded or unknown, with nothing saved", async () => {
    const { service, db } = await start();

    for (const provider of ["amazon_bedrock", "nope", "../x", 7])
      expect(
        await service.save({ provider, apiKey: DEEPSEEK_KEY }, null),
      ).toEqual({
        ok: false,
        issues: [{ field: "provider", code: "provider_invalid" }],
      });
    expect(
      await db.selectFrom("workspace_secrets").selectAll().execute(),
    ).toEqual([]);
  });

  // #555-T02
  it("is another workspace's secret not: a key stored in one workspace is not there in another", async () => {
    const { service, serviceOf, beta } = await start();
    await service.save({ provider: "deepseek", apiKey: DEEPSEEK_KEY }, null);

    expect(await serviceOf(beta).keyFor("deepseek")).toEqual({ state: "none" });
  });

  // #555-T02
  it("is listed with the other keys: the catalog providers that have a key, nothing for those without", async () => {
    const { service } = await start();
    await service.save({ provider: "deepseek", apiKey: DEEPSEEK_KEY }, null);
    await service.save({ provider: "openrouter", apiKey: ROUTER_KEY }, null);

    const stored = await service.nativeStatuses();

    // Only the catalog providers: the registry's two have their cards.
    expect(stored.map((entry) => entry.provider)).toEqual(["deepseek"]);
    expect(stored[0]?.status).toMatchObject({
      state: "configured",
      provider: "deepseek",
    });
    expect(JSON.stringify(stored)).not.toContain(DEEPSEEK_KEY);
  });
});
