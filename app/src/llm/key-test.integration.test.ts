// SPDX-License-Identifier: Apache-2.0

// The "test key" check against the fake LLM over real HTTP: an accepted key, a rejected one (401), an address
// where nothing answers, a provider that is slow or redirects, the key kept out of every message in every
// spelling, and the limits per workspace and for the instance.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  cleanUpAfterTest,
  createTestDatabase,
} from "../test-support/test-database.ts";
import {
  checkLlmKey,
  createLlmKeyTestService,
  KEY_TEST_GLOBAL_MAX,
  KEY_TEST_WINDOW_MS,
  KEY_TEST_WORKSPACE_MAX,
} from "./key-test.ts";

const KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

describe("checking a key against the provider", () => {
  // #104-LK-09
  it("succeeds for an accepted key, and the key travels only in the Authorization header", async () => {
    const fake = await setup();
    fake.acceptKeys([KEY]);

    const result = await checkLlmKey({ baseUrl: fake.baseUrl, apiKey: KEY });

    expect(result).toEqual({ ok: true });
    expect(fake.keyChecks()).toEqual([`Bearer ${KEY}`]);
  });

  // #104-LK-09
  it("reports a rejected key as llm_key_rejected, without the key even when the provider quotes it", async () => {
    const fake = await setup();
    fake.acceptKeys(["another-key-of-someone-else"]);
    fake.quoteKeyInErrors(true);

    const result = await checkLlmKey({ baseUrl: fake.baseUrl, apiKey: KEY });

    expect(result).toMatchObject({ ok: false, error: "llm_key_rejected" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY.slice(0, -4));
  });

  // #104-LK-09
  it("keeps the key out of the detail in every spelling a provider could repeat it in", async () => {
    const spellings = [
      KEY,
      encodeURIComponent(KEY),
      Buffer.from(KEY).toString("base64"),
      Buffer.from(KEY).toString("base64url"),
      Buffer.from(KEY).toString("hex"),
      Buffer.from(KEY).toString("hex").toUpperCase(),
    ];
    for (const spelling of spellings) {
      const server = createServer((_, response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: `Bad credential ${spelling} sent` },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      cleanUpAfterTest(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      );
      const port = (server.address() as { port: number }).port;

      const result = await checkLlmKey({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        apiKey: KEY,
      });

      expect(result).toMatchObject({ ok: false, error: "llm_key_rejected" });
      expect(JSON.stringify(result)).not.toContain(spelling);
      expect(JSON.stringify(result)).not.toContain(KEY.slice(6, -6));
    }
  });

  // #104-LK-09
  it("reports an address where nothing answers as llm_unreachable, without naming it", async () => {
    // A fake that is closed again at once: its port answers nothing.
    const fake = await startLlmFake();
    const baseUrl = fake.baseUrl;
    await fake.close();

    const result = await checkLlmKey({ baseUrl, apiKey: KEY });

    expect(result).toEqual({
      ok: false,
      error: "llm_unreachable",
      detail: null,
    });
  });

  it("reports a provider that does not answer in time as llm_unreachable", async () => {
    const server = createServer(() => {
      // never answers
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanUpAfterTest(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const port = (server.address() as { port: number }).port;

    const result = await checkLlmKey({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: KEY,
      timeoutMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      error: "llm_unreachable",
      detail: null,
    });
  });

  it("reports a server error as llm_unreachable and another error as llm_provider_error", async () => {
    const fake = await setup();
    fake.failWith({ status: 503, message: "overloaded" });
    const down = await checkLlmKey({ baseUrl: fake.baseUrl, apiKey: KEY });
    fake.failWith({ status: 429, message: "slow down" });
    const limited = await checkLlmKey({ baseUrl: fake.baseUrl, apiKey: KEY });

    expect(down).toMatchObject({ ok: false, error: "llm_unreachable" });
    expect(limited).toMatchObject({
      ok: false,
      error: "llm_provider_error",
      detail: "slow down",
    });
  });

  it("does not follow a redirect, so the key never travels to another host", async () => {
    const target = createServer((request, response) => {
      response.writeHead(200);
      response.end(request.headers.authorization ?? "");
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const seen: Array<string | undefined> = [];
    target.on("request", (request) => seen.push(request.headers.authorization));
    const targetPort = (target.address() as { port: number }).port;
    const redirecting = createServer((_, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${String(targetPort)}/key`,
      });
      response.end();
    });
    await new Promise<void>((resolve) =>
      redirecting.listen(0, "127.0.0.1", resolve),
    );
    for (const server of [target, redirecting])
      cleanUpAfterTest(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      );

    const result = await checkLlmKey({
      baseUrl: `http://127.0.0.1:${String((redirecting.address() as { port: number }).port)}`,
      apiKey: KEY,
    });

    expect(result).toMatchObject({ ok: false, error: "llm_provider_error" });
    expect(seen).toEqual([]);
  });

  it("cuts a long and noisy provider message down to one safe line", async () => {
    const fake = await setup();
    fake.failWith({
      status: 400,
      message: `first line\nsecond line ${"x".repeat(500)}`,
    });

    const result = await checkLlmKey({ baseUrl: fake.baseUrl, apiKey: KEY });

    expect(result).toEqual({
      ok: false,
      error: "llm_provider_error",
      detail: "first line",
    });
  });
});

describe("the limits of the test button", () => {
  async function service(now: () => Date = () => new Date()) {
    const { db } = await createTestDatabase();
    const fake = await setup();
    const lines: string[] = [];
    const key = createLlmKeyTestService({
      rateLimits: createRateLimitsRepository(db, now),
      baseUrlOf: () => fake.baseUrl,
      now,
      log: (line) => lines.push(line),
    });
    return { key, fake, lines, db };
  }
  const call = (key: Awaited<ReturnType<typeof service>>["key"], id: string) =>
    key.test({ workspaceId: id, provider: "openrouter", apiKey: KEY });

  // #104-LK-09
  it("refuses a workspace after its allowance, with the time left, and lets another workspace go on", async () => {
    const { key, fake } = await service();
    for (let i = 0; i < KEY_TEST_WORKSPACE_MAX; i += 1)
      expect(await call(key, "ws-a")).toEqual({ ok: true });

    const refused = await call(key, "ws-a");

    expect(refused).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: expect.any(Number),
    });
    expect(fake.keyChecks()).toHaveLength(KEY_TEST_WORKSPACE_MAX);
    expect(await call(key, "ws-b")).toEqual({ ok: true });
  });

  // #104-LK-09
  it("refuses everybody once the instance is out of budget, and takes back the attempt of a workspace over its own", async () => {
    const { key, db } = await service();
    const limits = createRateLimitsRepository(db);
    for (let i = 0; i < KEY_TEST_GLOBAL_MAX; i += 1)
      await limits.hit("llm-key-test:all", KEY_TEST_WINDOW_MS);

    const refused = await call(key, "ws-fresh");

    expect(refused).toMatchObject({ ok: false, error: "rate_limited" });
    // A workspace that is over its own allowance does not use up the instance's budget.
    const { key: other, db: otherDb } = await service();
    for (let i = 0; i < KEY_TEST_WORKSPACE_MAX + 3; i += 1)
      await call(other, "ws-a");
    const row = await otherDb
      .selectFrom("rate_limits")
      .select("count")
      .where("key", "=", "llm-key-test:all")
      .executeTakeFirstOrThrow();
    expect(row.count).toBe(KEY_TEST_WORKSPACE_MAX);
  });

  it("counts again after the window is over", async () => {
    let now = new Date("2026-10-12T10:00:00.000Z");
    const { key } = await service(() => now);
    for (let i = 0; i < KEY_TEST_WORKSPACE_MAX; i += 1) await call(key, "ws-a");
    expect(await call(key, "ws-a")).toMatchObject({ error: "rate_limited" });

    now = new Date(now.getTime() + KEY_TEST_WINDOW_MS);

    expect(await call(key, "ws-a")).toEqual({ ok: true });
  });

  it("logs the class of a failure and never the key", async () => {
    const { key, fake, lines } = await service();
    fake.acceptKeys([]);
    fake.quoteKeyInErrors(true);

    await call(key, "ws-a");

    expect(lines).toEqual(["[llm] KEY_TEST_FAILED: llm_key_rejected"]);
  });
});
