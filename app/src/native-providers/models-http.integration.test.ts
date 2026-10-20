// SPDX-License-Identifier: Apache-2.0

// The route that lists the models of a catalog provider for the model picker of a project (#555): for a workspace on its own key
// only. A workspace on the operator's key is told nothing: the answer is the one of a path that does not exist, so a member never
// learns a provider or a model id (principle 2 of epic #420).
import { describe, expect, it } from "vitest";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import type { NativeModelView } from "./catalog.ts";
import { createCatalogModelsHandler } from "./models-http.ts";

const MODELS: NativeModelView[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextTokens: 1_000_000,
    outputTokens: 384_000,
    reasoning: true,
    deprecated: false,
    alpha: false,
    price: { inputPerMillion: "0.66", outputPerMillion: "1.98" },
  },
];

function setup(ownKey = true) {
  const asked: string[] = [];
  const handler = createCatalogModelsHandler({
    catalog: {
      models: (slug) => {
        asked.push(slug);
        return Promise.resolve(slug === "deepseek" ? MODELS : undefined);
      },
    },
    ownKey: () => Promise.resolve(ownKey),
  });
  const access = {
    role: "member",
    user: { id: "u" },
    workspace: { id: "w", slug: "acme", name: "Acme" },
  } as unknown as WorkspaceAccess;
  return { handler, access, asked };
}

describe("the models of a catalog provider for a project", () => {
  // #555-T03
  it("lists the listed models with name, context and price for a workspace on its own key, to any member", async () => {
    const { handler, access } = setup();

    const response = await handler.list(access, "deepseek");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      provider: "deepseek",
      models: MODELS,
    });
  });

  // #555-T03
  it("answers 404 provider_not_found for a provider that is not offered, and for a spelling that is not the slug", async () => {
    const { handler, access } = setup();

    for (const provider of ["google", "nope", "DeepSeek", " deepseek", ""]) {
      const response = await handler.list(access, provider);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "provider_not_found" });
    }
  });

  // #555-T08
  it("answers a workspace on the operator's key as a path that does not exist, without asking the catalog", async () => {
    const { handler, access, asked } = setup(false);

    const response = await handler.list(access, "deepseek");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(asked).toEqual([]);
    // The answer is the same for a provider that exists and one that does not.
    const other = await handler.list(access, "nope");
    expect(await other.json()).toEqual({ error: "not_found" });
  });
});
