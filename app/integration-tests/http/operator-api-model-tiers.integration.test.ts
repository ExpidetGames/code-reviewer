// SPDX-License-Identifier: Apache-2.0

// The operator API's `GET|PUT /model-tiers` (#280) against a real database: the operator configures which model
// backs each managed tier, per kind of review. The format is checked against the contract file in
// compatibility/operator-api-contract.integration.test.ts, the route file in operator-api-route-files.integration.test.ts.
import { describe, expect, it } from "vitest";
import type {
  ModelCapabilityChecker,
  ModelCapabilityResult,
} from "../../src/llm/model-capabilities.ts";
import { startOperatorApiHarness } from "../../src/test-support/operator-api-harness.ts";

const PATH = "/api/operator/v1/model-tiers";

const SUPPORTED: ModelCapabilityResult = {
  outcome: "supported",
  capabilities: {
    tools: true,
    toolChoice: true,
    toolChoiceRequired: true,
    responseFormat: true,
    structuredOutputs: true,
    maxCompletionTokens: 8192,
    smallestCompletionTokens: 8192,
    contextLength: 200_000,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
  },
};

const FULL = {
  tiers: {
    low: { diff: "vendor/low-diff", dynamic: "vendor/low-dyn" },
    medium: { diff: "vendor/medium-diff", dynamic: "vendor/medium-dyn" },
    high: { diff: "vendor/high-diff", dynamic: "vendor/high-dyn" },
  },
};

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function start(
  answer: (modelId: string) => ModelCapabilityResult = () => SUPPORTED,
) {
  const asked: string[] = [];
  const modelCapabilities: ModelCapabilityChecker = {
    check: async (modelId) => {
      asked.push(modelId);
      return answer(modelId);
    },
  };
  const h = await startOperatorApiHarness({ modelCapabilities });
  return { ...h, asked };
}

describe("GET and PUT /model-tiers", () => {
  // #280-T01
  it("answers every tier and kind as not configured before anything was saved", async () => {
    const h = await start();

    const response = await h.call("GET", PATH);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toEqual({
      version: 1,
      tiers: {
        low: { diff: null, dynamic: null },
        medium: { diff: null, dynamic: null },
        high: { diff: null, dynamic: null },
      },
    });
  });

  // #280-T01
  it("stores what was put and answers it again, with the operator token", async () => {
    const h = await start();

    const put = await h.call("PUT", PATH, { body: FULL });
    const get = await h.call("GET", PATH);

    expect(put.status).toBe(200);
    expect(await json(put)).toEqual({ version: 1, ...FULL });
    expect(get.status).toBe(200);
    expect(await json(get)).toEqual({ version: 1, ...FULL });
  });

  // #280-T01
  it("replaces the whole configuration, and a tier or kind that is left out is not configured", async () => {
    const h = await start();
    await h.call("PUT", PATH, { body: FULL });

    const put = await h.call("PUT", PATH, {
      body: { tiers: { high: { diff: "vendor/only-high" } } },
    });

    const expected = {
      version: 1,
      tiers: {
        low: { diff: null, dynamic: null },
        medium: { diff: null, dynamic: null },
        high: { diff: "vendor/only-high", dynamic: null },
      },
    };
    expect(await json(put)).toEqual(expected);
    expect(await json(await h.call("GET", PATH))).toEqual(expected);
  });

  // #280-T02
  it("refuses a Dynamic model without tool choice and stores nothing", async () => {
    const h = await start((model) =>
      model === "vendor/no-tools"
        ? {
            outcome: "unsupported",
            capabilities: { ...SUPPORTED.capabilities!, tools: false },
          }
        : SUPPORTED,
    );
    await h.call("PUT", PATH, { body: FULL });

    const put = await h.call("PUT", PATH, {
      body: { tiers: { high: { dynamic: "vendor/no-tools" } } },
    });

    expect(put.status).toBe(422);
    expect(await json(put)).toEqual({
      version: 1,
      error: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
      field: "high.dynamic",
    });
    expect(await json(await h.call("GET", PATH))).toEqual({
      version: 1,
      ...FULL,
    });
  });

  // #280-T02
  it("refuses a Dynamic model the provider does not know", async () => {
    const h = await start(() => ({ outcome: "unknown_model" }));

    const put = await h.call("PUT", PATH, {
      body: { tiers: { low: { dynamic: "vendor/ghost" } } },
    });

    expect(put.status).toBe(422);
    expect(await json(put)).toMatchObject({ error: "DYNAMIC_MODEL_UNKNOWN" });
  });

  // #280-T03
  it("refuses a Dynamic model whose metadata is unreachable", async () => {
    const h = await start(() => ({ outcome: "unverifiable" }));

    const put = await h.call("PUT", PATH, {
      body: { tiers: { medium: { dynamic: "vendor/x" } } },
    });

    expect(put.status).toBe(422);
    expect(await json(put)).toEqual({
      version: 1,
      error: "DYNAMIC_MODEL_UNVERIFIED",
      field: "medium.dynamic",
    });
    expect((await json(await h.call("GET", PATH))).tiers).toEqual({
      low: { diff: null, dynamic: null },
      medium: { diff: null, dynamic: null },
      high: { diff: null, dynamic: null },
    });
  });

  it("does not ask the provider about a Diff model", async () => {
    const h = await start(() => ({ outcome: "unverifiable" }));

    const put = await h.call("PUT", PATH, {
      body: { tiers: { low: { diff: "vendor/diff-only" } } },
    });

    expect(put.status).toBe(200);
    expect(h.asked).toEqual([]);
  });

  it("refuses a model id with a space, naming the place and not the value", async () => {
    const h = await start();

    const put = await h.call("PUT", PATH, {
      body: { tiers: { low: { diff: "two words" } } },
    });

    expect(put.status).toBe(422);
    expect(await json(put)).toEqual({
      version: 1,
      error: "model_id_invalid",
      field: "low.diff",
    });
  });

  it.each([
    ["an unknown tier", { tiers: { ultra: { diff: "a/b" } } }],
    ["an unknown kind", { tiers: { low: { review: "a/b" } } }],
    ["an unknown top-level key", { tiers: {}, extra: true }],
    ["a model that is no string", { tiers: { low: { diff: 5 } } }],
    ["no tiers", {}],
  ])("answers 400 request_invalid for %s", async (_name, body) => {
    const h = await start();

    const put = await h.call("PUT", PATH, { body });

    expect(put.status).toBe(400);
    expect(await json(put)).toMatchObject({
      version: 1,
      error: "request_invalid",
    });
  });

  it("follows the rules of every route: token, method, body, media type", async () => {
    const h = await start();

    expect((await h.call("GET", PATH, { token: null })).status).toBe(401);
    expect((await h.call("GET", PATH, { token: "wrong" })).status).toBe(401);
    const post = await h.call("POST", PATH, { body: FULL });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, PUT");
    expect((await h.call("DELETE", PATH)).status).toBe(405);
    expect((await h.call("GET", PATH, { body: {} })).status).toBe(400);
    expect(
      (await h.call("PUT", PATH, { body: FULL, contentType: "text/plain" }))
        .status,
    ).toBe(415);
    expect((await h.call("PUT", PATH, { rawBody: "{nope" })).status).toBe(400);
  });

  it("logs the tiers that changed and the result, never a model id", async () => {
    const h = await start();

    await h.call("PUT", PATH, { body: FULL });
    await h.call("PUT", PATH, {
      body: { tiers: { low: { diff: "two words" } } },
    });

    const lines = h.lines.join("\n");
    expect(lines).toContain("put model-tiers");
    expect(lines).toContain("result=ok");
    expect(lines).toContain("result=model_id_invalid");
    expect(lines).not.toContain("vendor/");
    expect(lines).not.toContain("two words");
    expect(h.errors).toEqual([]);
  });
});
