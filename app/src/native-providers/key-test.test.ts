// SPDX-License-Identifier: Apache-2.0

// The key test of a catalog provider (#555): the generic adapter's cheap authenticated read, answered as a class. The
// requests go through an injected fetch; nothing leaves the process.
import { Socket } from "node:net";
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

  // #555-T02 (the review round of #548: the key is sent from the app server, so the default transport judges the address)
  describe("with the transport the running server uses", () => {
    type Lookup = (
      host: string,
      options: object,
      callback: (
        error: Error | null,
        address?: string,
        family?: number,
      ) => void,
    ) => void;

    // The test setup stops every connection to a host before the OS would resolve it. This stands in for the OS: it asks the
    // `lookup` the request was given, the way Node's connect does, records the address a connection would go to, and ends.
    function fakeConnect(connectedTo: string[]) {
      return vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
        this: Socket,
        ...args: unknown[]
      ) {
        const [options] = (Array.isArray(args[0]) ? args[0] : args) as [
          { host: string; lookup: Lookup },
        ];
        options.lookup(options.host, {}, (error, address) => {
          if (error === null && address !== undefined)
            connectedTo.push(address);
          this.destroy(error ?? new Error("Stopped after the lookup."));
        });
        return this;
      });
    }

    function testerFor(address: string) {
      const resolveAddresses = vi.fn(() =>
        Promise.resolve([{ address, family: 4 }]),
      );
      const tester = createNativeKeyTester({
        models: {
          // A name that passes the check made on the literal address; what it resolves to is judged at the connection.
          getProvider: () =>
            Promise.resolve(
              provider({
                url: {
                  state: "trusted",
                  trustedUrl: "https://api.deepseek.com",
                  pendingUrl: null,
                  problem: null,
                },
              }),
            ),
        },
        legacyProviders: ["openrouter", "anthropic"],
        resolveAddresses,
        // No fetchImpl: this is the transport of the running server.
      });
      return { tester, resolveAddresses };
    }

    // #555-T02
    it("answers unreachable for a name that resolves to a private address, and the key never leaves the process", async () => {
      const connectedTo: string[] = [];
      const connect = fakeConnect(connectedTo);
      const written = vi.spyOn(Socket.prototype, "write");
      const { tester, resolveAddresses } = testerFor("10.0.0.7");

      try {
        expect(await tester.test("deepseek", KEY)).toBe("unreachable");
        expect(resolveAddresses).toHaveBeenCalledWith("api.deepseek.com");
        expect(connectedTo).toEqual([]);
        expect(written).not.toHaveBeenCalled();
      } finally {
        written.mockRestore();
        connect.mockRestore();
      }
    });

    // #555-T02
    it("connects to the public address it vetted (the positive control of the test above)", async () => {
      const connectedTo: string[] = [];
      const connect = fakeConnect(connectedTo);
      const { tester } = testerFor("93.184.216.34");

      try {
        await tester.test("deepseek", KEY);
        expect(connectedTo).toEqual(["93.184.216.34"]);
      } finally {
        connect.mockRestore();
      }
    });
  });
});
