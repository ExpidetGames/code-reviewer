// SPDX-License-Identifier: Apache-2.0

// The "Test" button of the operator's keys in the admin portal (#427): the same one cheap call to the provider as
// the workspace's button, with limits and counters of its own, so a workspace clicking its button cannot use up
// the admin's allowance and the other way round.
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  cleanUpAfterTest,
  createTestDatabase,
} from "../test-support/test-database.ts";
import {
  KEY_TEST_GLOBAL_KEY,
  KEY_TEST_WINDOW_MS,
  createLlmKeyTestService,
} from "./key-test.ts";
import {
  OPERATOR_KEY_TEST_ADMIN_MAX,
  OPERATOR_KEY_TEST_GLOBAL_KEY,
  OPERATOR_KEY_TEST_GLOBAL_MAX,
  createOperatorKeyTestService,
  operatorKeyTestAdminKey,
} from "./operator-key-test.ts";
import { DEFAULT_LLM_PROVIDER } from "./providers/index.ts";

const KEY = "sk-or-v1-operator-0123456789abcdef0123456789abcdef";

async function start() {
  const { db } = await createTestDatabase();
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  const lines: string[] = [];
  const rateLimits = createRateLimitsRepository(db);
  const test = createOperatorKeyTestService({
    rateLimits,
    baseUrlOf: () => fake.baseUrl,
    log: (line) => lines.push(line),
  });
  return { db, fake, lines, rateLimits, test };
}
const call = (
  test: Awaited<ReturnType<typeof start>>["test"],
  adminId: string,
) => test.test({ adminId, provider: DEFAULT_LLM_PROVIDER, apiKey: KEY });

describe("the test button of the operator's keys", () => {
  // #427-T01
  it("asks the provider and answers whether the key is accepted, and the class of a failure", async () => {
    const { test, fake } = await start();

    expect(await call(test, "admin-1")).toEqual({ ok: true });
    fake.failWith({ status: 401, message: "no" });
    expect(await call(test, "admin-1")).toMatchObject({
      ok: false,
      error: "llm_key_rejected",
    });
    expect(fake.keyChecks()).toHaveLength(2);
  });

  // #427-T01
  it("refuses an admin after the allowance, with the time left, and lets another admin go on", async () => {
    const { test, fake } = await start();
    for (let i = 0; i < OPERATOR_KEY_TEST_ADMIN_MAX; i += 1)
      expect(await call(test, "admin-1")).toEqual({ ok: true });

    expect(await call(test, "admin-1")).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: expect.any(Number),
    });

    expect(fake.keyChecks()).toHaveLength(OPERATOR_KEY_TEST_ADMIN_MAX);
    expect(await call(test, "admin-2")).toEqual({ ok: true });
  });

  // #427-T01
  it("refuses everybody once the instance is out of budget, and takes back the attempt of an admin over their own", async () => {
    const { test, rateLimits } = await start();
    for (let i = 0; i < OPERATOR_KEY_TEST_GLOBAL_MAX; i += 1)
      await rateLimits.hit(OPERATOR_KEY_TEST_GLOBAL_KEY, KEY_TEST_WINDOW_MS);
    expect(await call(test, "admin-fresh")).toMatchObject({
      ok: false,
      error: "rate_limited",
    });

    const other = await start();
    for (let i = 0; i < OPERATOR_KEY_TEST_ADMIN_MAX + 3; i += 1)
      await call(other.test, "admin-1");
    const row = await other.db
      .selectFrom("rate_limits")
      .select("count")
      .where("key", "=", OPERATOR_KEY_TEST_GLOBAL_KEY)
      .executeTakeFirstOrThrow();
    expect(row.count).toBe(OPERATOR_KEY_TEST_ADMIN_MAX);
  });

  // #427-T01
  it("has counters of its own: it neither uses up nor is limited by the test button of a workspace", async () => {
    const { test, rateLimits, db, fake } = await start();
    const workspaceTest = createLlmKeyTestService({
      pinnedAddresses: async () => [],
      rateLimits,
      baseUrlOf: () => fake.baseUrl,
    });

    await call(test, "admin-1");
    await workspaceTest.test({
      workspaceId: "ws-a",
      provider: DEFAULT_LLM_PROVIDER,
      apiKey: KEY,
    });

    const keys = (await db.selectFrom("rate_limits").select("key").execute())
      .map((row) => row.key)
      .sort();
    expect(keys).toEqual(
      [
        KEY_TEST_GLOBAL_KEY,
        "llm-key-test:workspace:ws-a",
        OPERATOR_KEY_TEST_GLOBAL_KEY,
        operatorKeyTestAdminKey("admin-1"),
      ].sort(),
    );
    expect(
      new Set([
        KEY_TEST_GLOBAL_KEY,
        OPERATOR_KEY_TEST_GLOBAL_KEY,
        operatorKeyTestAdminKey("admin-1"),
      ]).size,
    ).toBe(3);
    // The workspace button's instance budget is untouched by the admin's clicks.
    const workspaceGlobal = await db
      .selectFrom("rate_limits")
      .select("count")
      .where("key", "=", KEY_TEST_GLOBAL_KEY)
      .executeTakeFirstOrThrow();
    expect(workspaceGlobal.count).toBe(1);
  });

  // #427-T07
  it("logs the class of a failure and never the key", async () => {
    const { test, fake, lines } = await start();
    fake.failWith({ status: 401, message: `bad key ${KEY}` });

    await call(test, "admin-1");

    expect(lines).toEqual(["[llm] OPERATOR_KEY_TEST_FAILED: llm_key_rejected"]);
    expect(lines.join("\n")).not.toContain(KEY);
  });
});
