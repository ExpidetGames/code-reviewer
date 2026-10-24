// SPDX-License-Identifier: LicenseRef-Proprietary

// The generic provider adapter built from catalog data (#548, part D): descriptor, wire family, key header and model list
// from the stored rows, and a best-effort key test per family. The requests are checked through an injected fetch; nothing
// leaves the process.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StoredModel, StoredProvider } from "./catalog.ts";
import { createGenericAdapter } from "./generic-adapter.ts";
import { parseModelsDev } from "./parse.ts";
import { supportedProvider } from "./opencode-providers.ts";
import { planCatalog } from "./plan.ts";

const NOW = new Date("2026-10-19T03:00:00.000Z");
const body = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fakes",
      "fixtures",
      "models-dev",
      "api.json",
    ),
    "utf8",
  ),
) as unknown;

/** The address the check passes: the default the committed file records, else one made up for the provider. */
function addressOf(id: string): string {
  return (
    supportedProvider(id)?.defaultBaseUrl ?? `https://api.${id}.example/v1`
  );
}

function rows() {
  const parsed = parseModelsDev(body);
  if (!parsed.ok) throw new Error("fixture");
  const plan = planCatalog({
    parsed,
    stored: { providers: [], models: [] },
    urlChecks: new Map(
      parsed.providers.map((p) => [
        p.id,
        { ok: true as const, url: addressOf(p.id) },
      ]),
    ),
    now: NOW,
  });
  return {
    provider: (id: string) =>
      plan.write.providers.find((p) => p.id === id) as StoredProvider,
    models: (id: string) =>
      plan.write.models.filter((m) => m.providerId === id) as StoredModel[],
  };
}

type Call = { url: string; headers: Record<string, string>; init: RequestInit };
function recorder(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      init,
    });
    return answer();
  };
  return { calls, fetchImpl };
}
const status =
  (code: number, text = "") =>
  () =>
    new Response(text, { status: code });

function adapterOf(providerId: string) {
  const r = rows();
  const adapter = createGenericAdapter(
    r.provider(providerId),
    r.models(providerId),
  );
  if (!adapter.ok) throw new Error(adapter.code);
  return adapter.adapter;
}

describe("the generic adapter", () => {
  // #548-T09
  it("takes the descriptor, family, key header and address from the catalog", () => {
    const adapter = adapterOf("deepseek");

    expect(adapter).toMatchObject({
      id: "deepseek",
      label: "DeepSeek",
      npm: "@ai-sdk/openai-compatible",
      family: "openai-chat",
      authHeader: "Authorization",
      baseUrl: "https://api.deepseek.example/v1",
    });
  });

  // #548-T09
  it("lists the models of the catalog, with the unlisted and deprecated ones marked, not hidden", () => {
    const r = rows();
    const models = r
      .models("deepseek")
      .map((m) =>
        m.id === "deepseek-v4-pro"
          ? { ...m, unlistedAt: NOW.toISOString() }
          : m,
      );

    const result = createGenericAdapter(r.provider("deepseek"), models);
    if (!result.ok) throw new Error(result.code);

    expect(result.adapter.models.map((m) => m.id).sort()).toEqual([
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ]);
    expect(
      result.adapter.models.find((m) => m.id === "deepseek-v4-pro"),
    ).toMatchObject({ unlisted: true, deprecated: false });
    expect(
      result.adapter.models.find((m) => m.id === "deepseek-v4-flash"),
    ).toMatchObject({ unlisted: false, deprecated: true });
    expect(
      result.adapter.models.find((m) => m.id === "deepseek-flash"),
    ).toMatchObject({ unlisted: false, deprecated: false });
  });

  // #548-T09
  it("marks an alpha model as a warning like a deprecated one: kept, listed, and the entry still runs it", () => {
    const r = rows();
    const models = r
      .models("deepseek")
      .map((m) =>
        m.id === "deepseek-v4-pro" ? { ...m, status: "alpha" as const } : m,
      );

    const result = createGenericAdapter(r.provider("deepseek"), models);
    if (!result.ok) throw new Error(result.code);

    const byId = (id: string) => result.adapter.models.find((m) => m.id === id);
    expect(byId("deepseek-v4-pro")).toMatchObject({
      alpha: true,
      deprecated: false,
      unlisted: false,
    });
    expect(byId("deepseek-v4-flash")).toMatchObject({
      alpha: false,
      deprecated: true,
    });
    expect(byId("deepseek-flash")).toMatchObject({
      alpha: false,
      deprecated: false,
    });
  });

  // #548-T09
  it("checks a model id as a catalog model of this provider, and prices it from the catalog or says it does not know", () => {
    const adapter = adapterOf("deepseek");

    expect(adapter.checkModelId("deepseek-v4-pro")).toBe(true);
    expect(adapter.checkModelId("not a model")).toBe(false);
    expect(adapter.priceOf("deepseek-v4-pro")).toMatchObject({
      contextTokens: expect.any(Number),
      inputTokenFactor: 1,
    });
    expect(adapter.priceOf("deepseek-v4-pro")?.inputPerMillion).toBeGreaterThan(
      0,
    );
    expect(adapter.priceOf("nobody")).toBeNull();
  });

  // #548-T09
  it("gives no adapter for a provider that is unsupported or whose address is not trusted", () => {
    const r = rows();
    const provider = r.provider("deepseek");

    expect(
      createGenericAdapter({ ...provider, id: "amazon-bedrock" }, []),
    ).toEqual({ ok: false, code: "provider_unsupported" });
    expect(
      createGenericAdapter(
        {
          ...provider,
          url: {
            state: "url_changed",
            trustedUrl: "https://a.example/v1",
            pendingUrl: "https://b.example/v1",
            problem: null,
          },
        },
        r.models("deepseek"),
      ),
    ).toEqual({ ok: false, code: "provider_url_blocked" });
  });
});

describe("the key test of the generic adapter", () => {
  // #548-T09
  it.each([
    [
      "deepseek",
      "https://api.deepseek.example/v1/models",
      { authorization: "Bearer sk-test" },
    ],
    [
      "openai",
      "https://api.openai.com/v1/models",
      { authorization: "Bearer sk-test" },
    ],
    [
      "anthropic",
      "https://api.anthropic.com/v1/models",
      { "x-api-key": "sk-test", "anthropic-version": "2023-06-01" },
    ],
    [
      "google",
      "https://generativelanguage.googleapis.com/v1beta/models",
      { "x-goog-api-key": "sk-test" },
    ],
  ])(
    "asks the model list of %s with the key in the header of its family",
    async (providerId, url, headers) => {
      const { calls, fetchImpl } = recorder(status(200, "{}"));

      const check = await adapterOf(providerId).testKey({
        apiKey: "sk-test",
        fetchImpl,
      });

      expect(check).toEqual({ outcome: "accepted" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(url);
      expect(calls[0]?.headers).toMatchObject(headers);
      expect(calls[0]?.init.method).toBe("GET");
      expect(calls[0]?.init.redirect).toBe("manual");
    },
  );

  // #548-T09
  it.each([
    [200, "accepted"],
    [401, "rejected"],
    [403, "rejected"],
    [404, "not_verified"],
    [405, "not_verified"],
    [501, "not_verified"],
    [429, "provider_error"],
    [302, "provider_error"],
    [400, "provider_error"],
    [500, "unreachable"],
    [503, "unreachable"],
  ])("answers a %i with %s", async (code, outcome) => {
    const { fetchImpl } = recorder(status(code));

    expect(
      await adapterOf("deepseek").testKey({ apiKey: "sk-test", fetchImpl }),
    ).toEqual({ outcome });
  });

  // #548-T09
  it("calls a provider without a model list not verified, which is an answer and not a failure", async () => {
    const { fetchImpl } = recorder(status(404, "no such route"));

    const check = await adapterOf("deepseek").testKey({
      apiKey: "sk-test",
      fetchImpl,
    });

    expect(check).toEqual({ outcome: "not_verified" });
  });

  // #548-T09
  it("says unreachable for a failed connection, without the text of the error or the key", async () => {
    const fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:443 key=sk-test");
    };

    const check = await adapterOf("deepseek").testKey({
      apiKey: "sk-test",
      fetchImpl,
    });

    expect(check).toEqual({ outcome: "unreachable" });
    expect(JSON.stringify(check)).not.toContain("sk-test");
  });

  // #548-T07
  it("sends the key through the connect guard by default, never to a name that now resolves to a private address", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const r = rows();
    const made = createGenericAdapter(
      r.provider("deepseek"),
      r.models("deepseek"),
      {
        resolveAddresses: async () => [{ address: "10.0.0.7", family: 4 }],
      },
    );
    if (!made.ok) throw new Error(made.code);

    const check = await made.adapter.testKey({ apiKey: "sk-test" });

    expect(check).toEqual({ outcome: "unreachable" });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  // #548-T09
  it("never echoes what the provider answered", async () => {
    const { fetchImpl } = recorder(
      status(401, "Incorrect API key provided: sk-test"),
    );

    const check = await adapterOf("deepseek").testKey({
      apiKey: "sk-test",
      fetchImpl,
    });

    expect(JSON.stringify(check)).not.toContain("sk-test");
  });
});
