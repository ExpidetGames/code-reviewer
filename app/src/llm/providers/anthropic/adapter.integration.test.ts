// SPDX-License-Identifier: Apache-2.0

// #511-T09: the key test of the Anthropic adapter against the fake LLM over real HTTP, reached through the registry.
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "../../../test-support/test-database.ts";
import { llmProviderAdapters } from "../server.ts";

const KEY = "dummy-anthropic-api03-dummy-0123456789abcdef0123456789abcdef";
const adapter = llmProviderAdapters.get("anthropic");

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

describe("the Anthropic adapter against the fake LLM", () => {
  // #511-T09
  it("tests an accepted key with the headers Anthropic requires, and reports a rejected one", async () => {
    const fake = await setup();
    fake.acceptKeys([KEY]);

    expect(
      await adapter.testKey({ baseUrl: fake.baseUrl, apiKey: KEY }),
    ).toEqual({ ok: true });
    const rejected = await adapter.testKey({
      baseUrl: fake.baseUrl,
      apiKey: "another-key",
    });

    expect(rejected).toMatchObject({ ok: false, error: "llm_key_rejected" });
    expect(fake.anthropicKeyChecks()).toEqual([
      { apiKey: KEY, version: "2023-06-01" },
      { apiKey: "another-key", version: "2023-06-01" },
    ]);
    // The other provider's check is not involved.
    expect(fake.keyChecks()).toEqual([]);
  });

  // #511-T09
  it.each([
    [401, "llm_key_rejected"],
    [403, "llm_key_rejected"],
    [429, "llm_provider_error"],
    [400, "llm_provider_error"],
    [404, "llm_provider_error"],
    [500, "llm_unreachable"],
    [529, "llm_unreachable"],
  ])("maps the answer %i to %s", async (status, code) => {
    const fake = await setup();
    fake.failWith({ status, message: "the provider says no" });

    expect(
      await adapter.testKey({ baseUrl: fake.baseUrl, apiKey: KEY }),
    ).toMatchObject({ ok: false, error: code });
  });

  // #511-T09
  it("reports an address nobody answers at as unreachable", async () => {
    // A server that is closed before the call; it is not registered for the clean-up, which would close it twice.
    const fake = await startLlmFake();
    const baseUrl = fake.baseUrl;
    await fake.close();

    expect(await adapter.testKey({ baseUrl, apiKey: KEY })).toEqual({
      ok: false,
      error: "llm_unreachable",
      detail: null,
    });
  });

  // #511-T09
  it("never puts the key into a result, even when the provider repeats it", async () => {
    const fake = await setup();
    fake.acceptKeys(["some-other-key"]);
    fake.quoteKeyInErrors(true);

    const result = await adapter.testKey({
      baseUrl: fake.baseUrl,
      apiKey: KEY,
    });

    expect(result).toMatchObject({ ok: false, error: "llm_key_rejected" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  // #511-T09
  it("does not follow a redirect with the key", async () => {
    const seen: string[] = [];
    const fetchImpl = (url: string, init: RequestInit) => {
      seen.push(`${url} ${String(init.redirect)}`);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.invalid/" },
        }),
      );
    };

    const result = await adapter.testKey({
      baseUrl: "https://api.example.invalid/v1",
      apiKey: KEY,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, error: "llm_provider_error" });
    expect(seen).toEqual([
      "https://api.example.invalid/v1/models?limit=1 manual",
    ]);
  });
});
