// SPDX-License-Identifier: Apache-2.0

// The key test of a catalog provider (#555): the generic adapter's cheap authenticated read, answered as a class. The
// requests go through an injected fetch; nothing leaves the process.
import { describe, expect, it, vi } from "vitest";
import type { StoredProvider } from "../models-dev/catalog.ts";
import { createNativeKeyTester } from "./key-test.ts";

const KEY = "sk-deepseek-typed-0123456789abcdef";

function provider(overrides: Partial<StoredProvider> = {}): StoredProvider {
  return {
    id: "deepseek",
    name: "DeepSeek",
    url: {
      state: "trusted",
      trustedUrl: "https://api.deepseek.example",
      pendingUrl: null,
      problem: null,
    },
    urlChangedAt: null,
    firstSeenAt: "2026-10-19T03:00:00.000Z",
    unlistedAt: null,
    updatedAt: "2026-10-19T03:00:00.000Z",
    ...overrides,
  };
}

function setup(
  stored: StoredProvider | undefined,
  answer: () => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return Promise.resolve(answer());
  });
  const tester = createNativeKeyTester({
    models: { getProvider: () => Promise.resolve(stored) },
    legacyProviders: ["openrouter", "anthropic"],
    fetchImpl,
  });
  return { tester, calls, fetchImpl };
}

describe("the key test of a catalog provider", () => {
  // #555-T02
  it("asks the model list of the trusted address with the key in the header of the provider's wire", async () => {
    const t = setup(provider(), () => new Response("{}", { status: 200 }));

    expect(await t.tester.test("deepseek", KEY)).toBe("accepted");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe("https://api.deepseek.example/models");
    expect(t.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  // #555-T02
  it("answers rejected for a key the provider refuses", async () => {
    for (const code of [401, 403])
      expect(
        await setup(
          provider(),
          () => new Response("", { status: code }),
        ).tester.test("deepseek", KEY),
      ).toBe("rejected");
  });

  // #555-T02
  it("answers not_verified for a provider with no model list to ask: that says nothing about the key", async () => {
    for (const code of [404, 405, 501])
      expect(
        await setup(
          provider(),
          () => new Response("", { status: code }),
        ).tester.test("deepseek", KEY),
      ).toBe("not_verified");
  });

  // #555-T02
  it("answers a class for an outage or any other answer, and never repeats what the provider said", async () => {
    const down = setup(provider(), () => new Response(KEY, { status: 503 }));
    const odd = setup(provider(), () => new Response(KEY, { status: 429 }));
    const broken = setup(provider(), () => {
      throw new Error(`connect failed for ${KEY}`);
    });

    expect(await down.tester.test("deepseek", KEY)).toBe("unreachable");
    expect(await odd.tester.test("deepseek", KEY)).toBe("provider_error");
    expect(await broken.tester.test("deepseek", KEY)).toBe("unreachable");
  });

  // #555-T02
  it("sends nothing to a provider that is blocked, unknown, unlisted or not a catalog provider", async () => {
    const blocked = setup(
      provider({
        url: {
          state: "url_changed",
          trustedUrl: "https://api.deepseek.example",
          pendingUrl: "https://elsewhere.example",
          problem: null,
        },
      }),
      () => new Response("", { status: 200 }),
    );
    const missing = setup(undefined, () => new Response("", { status: 200 }));
    const legacy = setup(provider(), () => new Response("", { status: 200 }));

    expect(await blocked.tester.test("deepseek", KEY)).toBe("unavailable");
    expect(await missing.tester.test("deepseek", KEY)).toBe("unavailable");
    expect(await missing.tester.test("amazon_bedrock", KEY)).toBe(
      "unavailable",
    );
    expect(await legacy.tester.test("openrouter", KEY)).toBe("unavailable");
    for (const t of [blocked, missing, legacy])
      expect(t.fetchImpl).not.toHaveBeenCalled();
  });
});
