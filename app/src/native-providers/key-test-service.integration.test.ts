// SPDX-License-Identifier: Apache-2.0

// The "test key" service for a catalog provider (#555): the same limits as for the registry's providers, and the answers
// verified, not verified and rejected. The provider's side is a stub; nothing leaves the process.
import { describe, expect, it } from "vitest";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  createLlmKeyTestService,
  KEY_TEST_WORKSPACE_MAX,
} from "../llm/key-test.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import type { NativeKeyOutcome, NativeKeyTester } from "./key-test.ts";

const KEY = "sk-deepseek-typed-0123456789abcdef";

async function setup(outcome: NativeKeyOutcome = "accepted") {
  const { db } = await createTestDatabase();
  const asked: Array<{ slug: string; apiKey: string }> = [];
  const native: NativeKeyTester = {
    test: (slug, apiKey) => {
      asked.push({ slug, apiKey });
      return Promise.resolve(outcome);
    },
  };
  const lines: string[] = [];
  const service = createLlmKeyTestService({
    rateLimits: createRateLimitsRepository(db),
    baseUrlOf: () => "https://registry.example/api/v1",
    native,
    log: (line) => lines.push(line),
  });
  return { service, asked, lines };
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
    expect(asked).toEqual([{ slug: "deepseek", apiKey: KEY }]);
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
