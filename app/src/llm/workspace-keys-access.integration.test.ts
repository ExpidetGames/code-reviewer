// SPDX-License-Identifier: Apache-2.0

// The own-mode resolver takes the key of the provider a job is for, assembled over a real database (#426): a key
// of one provider is never handed to a job of another, and every provider's key is masked in a result.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createWorkspaceLlm } from "./assemble.ts";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "./providers/fake-adapter.ts";
import { openrouterDescriptor } from "./providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "./providers/registry.ts";

const OPENROUTER_KEY = "sk-or-v1-workspace-key-0000000000000000";
const FAKE_KEY = "fk-live-workspace-key-1111111111111111";

async function start() {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "alpha");
  const llm = createWorkspaceLlm({
    db,
    appSecret: () => "workspace-keys-access-app-secret-0123456789",
    env: () => ({}),
    providers: createProviderRegistry([
      openrouterDescriptor,
      createFakeAdapter(),
    ]),
  });
  return { llm, workspaceId, keys: llm.keyServiceFor(workspaceId) };
}

describe("the key of the provider a job is for", () => {
  // #426-T01
  it("is the key of that provider, and a provider without a key fails with no_key instead of borrowing another", async () => {
    const { llm, workspaceId, keys } = await start();
    await keys.save({ provider: "openrouter", apiKey: OPENROUTER_KEY }, null);

    const forOpenRouter = await llm.accessFor(workspaceId, "openrouter");
    const forFake = await llm.accessFor(workspaceId, FAKE_PROVIDER_ID);

    expect(forOpenRouter).toMatchObject({
      ok: true,
      source: "workspace",
      access: { provider: "openrouter", apiKey: OPENROUTER_KEY },
    });
    expect(forFake).toMatchObject({ ok: false, reason: "no_key" });

    await keys.save({ provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY }, null);

    expect(await llm.accessFor(workspaceId, FAKE_PROVIDER_ID)).toMatchObject({
      ok: true,
      access: { provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY },
    });
    // Without a provider the default one is meant, until a project can choose.
    expect(await llm.accessFor(workspaceId)).toMatchObject({
      ok: true,
      access: { provider: "openrouter", apiKey: OPENROUTER_KEY },
    });
  });

  // #426-T01
  it("fails closed for the provider whose key was removed, whatever the other provider has", async () => {
    const { llm, workspaceId, keys } = await start();
    await keys.save({ provider: "openrouter", apiKey: OPENROUTER_KEY }, null);
    await keys.save({ provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY }, null);
    await keys.remove(FAKE_PROVIDER_ID);

    const summary = await llm.summaryFor(workspaceId, FAKE_PROVIDER_ID);

    expect(summary).toEqual({ configured: false, reason: "no_key" });
  });
});

describe("the keys to mask in a result", () => {
  // #426-T05
  it("are those of every provider the workspace has a key for", async () => {
    const { llm, workspaceId, keys } = await start();
    await keys.save({ provider: "openrouter", apiKey: OPENROUTER_KEY }, null);
    await keys.save({ provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY }, null);

    const current = await llm.currentKeysFor(workspaceId);

    expect([...current].sort()).toEqual([FAKE_KEY, OPENROUTER_KEY].sort());
  });
});
