// SPDX-License-Identifier: LicenseRef-Proprietary

// The access a job of a workspace gets for a catalog provider (#555), assembled over a real database: only the key of that
// provider is revealed, a provider without a key fails with `no_key`, and the keys of the catalog providers are masked in a
// result with the others.
import { describe, expect, it } from "vitest";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";

const DEEPSEEK_KEY = "sk-deepseek-workspace-key-0000000000000000";
const OPENAI_KEY = "sk-openai-workspace-key-1111111111111111";

async function start() {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "alpha");
  const llm = createWorkspaceLlm({
    db,
    appSecret: () => "native-access-app-secret-0123456789-0123456789",
    env: () => ({}),
  });
  return { llm, workspaceId, keys: llm.keyServiceFor(workspaceId) };
}

describe("the key of a catalog provider a job is for", () => {
  // #555-T05
  it("is the key of that provider only", async () => {
    const { llm, workspaceId, keys } = await start();
    await keys.save({ provider: "deepseek", apiKey: DEEPSEEK_KEY }, null);
    await keys.save({ provider: "openai", apiKey: OPENAI_KEY }, null);

    const access = await llm.keyFor(workspaceId, {
      keyMode: "own",
      provider: "deepseek",
    });

    expect(access).toMatchObject({
      ok: true,
      source: "workspace",
      access: { provider: "deepseek", apiKey: DEEPSEEK_KEY },
    });
  });

  // #555-T06
  it("fails with llm_not_configured when the workspace has a key only for another provider", async () => {
    const { llm, workspaceId, keys } = await start();
    await keys.save({ provider: "openai", apiKey: OPENAI_KEY }, null);

    const access = await llm.keyFor(workspaceId, {
      keyMode: "own",
      provider: "deepseek",
    });

    expect(access).toMatchObject({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "no_key",
    });
    expect(JSON.stringify(access)).not.toContain(OPENAI_KEY);
  });

  // #555-T06
  it("is not offered to a workspace on the operator's key: a catalog provider has no operator key", async () => {
    const { llm, workspaceId } = await start();

    const access = await llm.keyFor(workspaceId, {
      keyMode: "managed",
      provider: "deepseek",
    });

    expect(access).toMatchObject({ ok: false, reason: "operator_key_missing" });
  });

  // #555-T02
  it("is masked in a result with the other keys of the workspace", async () => {
    const { llm, workspaceId, keys } = await start();
    await keys.save({ provider: "deepseek", apiKey: DEEPSEEK_KEY }, null);
    await keys.save({ provider: "openai", apiKey: OPENAI_KEY }, null);

    expect([...(await llm.currentKeysFor(workspaceId))].sort()).toEqual(
      [DEEPSEEK_KEY, OPENAI_KEY].sort(),
    );
  });
});
