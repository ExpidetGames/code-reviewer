// SPDX-License-Identifier: LicenseRef-Proprietary

// The "test key" service for a catalog provider (#555): the same limits as for the registry's providers, and the answers
// verified, not verified and rejected. The provider's side is a stub; nothing leaves the process.
import { describe, expect, it } from "vitest";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  createLlmKeyTestService,
  KEY_TEST_WORKSPACE_MAX,
  keyTestWorkspaceKey,
} from "../llm/key-test.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import type { NativeKeyOutcome, NativeKeyTester } from "./key-test.ts";

const KEY = "sk-deepseek-typed-0123456789abcdef";

async function setup(
  outcome: NativeKeyOutcome = "accepted",
  holds = true,
  pins: readonly string[] = ["https://api.deepseek.example"],
) {
  const { db } = await createTestDatabase();
  const asked: Array<{ slug: string; apiKey: string; pinned?: string[] }> = [];
  const pinsAsked: Array<{ workspaceId: string; slug: string }> = [];
  const held: Array<{ slug: string; pinned: string[] }> = [];
  const native: NativeKeyTester = {
    test: (slug, apiKey, pinned) => {
      asked.push({ slug, apiKey, pinned: [...pinned] });
      return Promise.resolve(outcome);
    },
    addressHolds: (slug, pinned) => {
      held.push({ slug, pinned: [...pinned] });
      return Promise.resolve(holds);
    },
  };
  const lines: string[] = [];
  const service = createLlmKeyTestService({
    rateLimits: createRateLimitsRepository(db),
    baseUrlOf: () => "https://registry.example/api/v1",
    native,
    pinnedAddresses: (workspaceId, slug) => {
      pinsAsked.push({ workspaceId, slug });
      return Promise.resolve(pins);
    },
    log: (line) => lines.push(line),
  });
  return {
    service,
    asked,
    lines,
    pinsAsked,
    held,
    rateLimits: createRateLimitsRepository(db),
  };
}

const test = (
  service: Awaited<ReturnType<typeof setup>>["service"],
  id = "ws-a",
) => service.test({ workspaceId: id, provider: "deepseek", apiKey: KEY });

describe("the key test of a catalog provider", () => {
  // #555-T02
  it("is verified when the provider accepts the key, and asks the catalog provider rather than the registry", async () => {
    const { service, asked } = await setup("accepted");

    expect(await test(service)).toEqual({ ok: true });
    expect(asked).toEqual([
      {
        slug: "deepseek",
        apiKey: KEY,
        pinned: ["https://api.deepseek.example"],
      },
    ]);
  });

  // #588-T25
  it("holds the test to the address the workspace's projects pinned: it asks for the pins of this workspace and this provider", async () => {
    const { service, pinsAsked } = await setup("accepted");

    await test(service, "ws-b");

    expect(pinsAsked).toEqual([{ workspaceId: "ws-b", slug: "deepseek" }]);
  });

  // #588-T25
  it("is llm_provider_address_changed, without the key, when the catalog's address is not the pinned one", async () => {
    const { service, lines } = await setup("address_changed");

    const result = await test(service);

    expect(result).toEqual({
      ok: false,
      error: "llm_provider_address_changed",
      detail: null,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(lines).toEqual([
      "[llm] KEY_TEST_FAILED: llm_provider_address_changed",
    ]);
  });

  // #588-T46
  it("refuses before the key is needed when the pins do not hold, leaves the allowance of the workspace alone and logs the class only", async () => {
    const { service, held, asked, lines, rateLimits } = await setup(
      "accepted",
      false,
      ["https://api.deepseek-old.example"],
    );

    const result = await service.preflight({
      workspaceId: "ws-a",
      provider: "deepseek",
    });

    expect(result).toEqual({
      ok: false,
      error: "llm_provider_address_changed",
      detail: null,
    });
    expect(held).toEqual([
      { slug: "deepseek", pinned: ["https://api.deepseek-old.example"] },
    ]);
    expect(asked).toEqual([]);
    expect(lines).toEqual([
      "[llm] KEY_TEST_FAILED: llm_provider_address_changed",
    ]);
    expect(
      await rateLimits.hit(keyTestWorkspaceKey("ws-a"), 1000),
    ).toMatchObject({ count: 1 });
  });

  // #588-T46
  it("lets the test go on when the pins hold, and asks nothing about a provider of the registry", async () => {
    const { service, pinsAsked } = await setup("accepted", true);

    expect(
      await service.preflight({ workspaceId: "ws-a", provider: "deepseek" }),
    ).toBeNull();
    expect(
      await service.preflight({ workspaceId: "ws-a", provider: "openrouter" }),
    ).toBeNull();
    expect(pinsAsked).toEqual([{ workspaceId: "ws-a", slug: "deepseek" }]);
  });

  // #555-T02
  it("is not verified, and not an error, when the provider has no list to ask", async () => {
    const { service, lines } = await setup("not_verified");

    expect(await test(service)).toEqual({ ok: true, verified: false });
    expect(lines).toEqual([]);
  });

  // #555-T02
  it.each([
    ["rejected", "llm_key_rejected"],
    ["unreachable", "llm_unreachable"],
    ["provider_error", "llm_provider_error"],
  ] as const)("is %s as %s, without the key", async (outcome, error) => {
    const { service, lines } = await setup(outcome);

    const result = await test(service);

    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(lines).toEqual([`[llm] KEY_TEST_FAILED: ${error}`]);
  });

  // #555-T02
  it("is a provider error for a provider that is not usable: nothing was sent", async () => {
    const { service } = await setup("unavailable");

    expect(await test(service)).toMatchObject({
      ok: false,
      error: "llm_provider_error",
    });
  });

  // #555-T02
  it("shares the allowance of the workspace with the registry's providers", async () => {
    const { service } = await setup("accepted");
    for (let i = 0; i < KEY_TEST_WORKSPACE_MAX; i += 1)
      await service.test({
        workspaceId: "ws-a",
        provider: i % 2 === 0 ? "deepseek" : "openrouter",
        apiKey: KEY,
      });

    expect(await test(service)).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });
});
