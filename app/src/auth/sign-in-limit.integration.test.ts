// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the limit on email and password sign in attempts against the real shared counters:
// about 5 attempts per 15 minutes per email address, the same for an address nobody owns, a
// generous limit for the whole instance, and a fresh start after a success or the end of the window.
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createTestDatabase, track } from "../test-support/test-database.ts";
import { handleAuthRequest } from "./http.ts";
import {
  accountKey,
  createSignInLimiter,
  SIGN_IN_ACCOUNT_MAX_ATTEMPTS,
  SIGN_IN_ACCOUNT_WINDOW_MS,
  SIGN_IN_GLOBAL_MAX_ATTEMPTS,
  SIGN_IN_GLOBAL_WINDOW_MS,
} from "./sign-in-limit.ts";

async function fixture() {
  const { db } = await createTestDatabase();
  let time = Date.parse("2026-10-11T08:00:00.000Z");
  const now = () => new Date(time);
  const limiter = createSignInLimiter(createRateLimitsRepository(db, now), now);
  return {
    db,
    limiter,
    advance(ms: number) {
      time += ms;
    },
  };
}

async function attempts(
  limiter: Awaited<ReturnType<typeof fixture>>["limiter"],
  email: string,
  times: number,
) {
  const results = [];
  for (let attempt = 0; attempt < times; attempt += 1)
    results.push(await limiter.check(email));
  return results;
}

describe("the sign in limit per account", () => {
  // #97-LIMIT
  it("lets 5 attempts through and refuses the 6th with the time to wait", async () => {
    const { limiter } = await fixture();

    const results = await attempts(limiter, "admin@example.com", 6);

    expect(results.slice(0, SIGN_IN_ACCOUNT_MAX_ATTEMPTS)).toEqual(
      Array(SIGN_IN_ACCOUNT_MAX_ATTEMPTS).fill({ allowed: true }),
    );
    expect(results[5]).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  // #97-LIMIT
  it("treats an address nobody owns exactly like a known one", async () => {
    const { limiter } = await fixture();

    const known = await attempts(limiter, "admin@example.com", 8);
    const unknown = await attempts(limiter, "nobody@example.com", 8);

    expect(unknown).toEqual(known);
  });

  it("counts the address however it is written", async () => {
    const { limiter } = await fixture();
    await attempts(limiter, "Admin@Example.com", 3);
    await attempts(limiter, "  admin@example.com ", 2);

    expect(await limiter.check("ADMIN@EXAMPLE.COM")).toMatchObject({
      allowed: false,
    });
  });

  it("keeps the counters of different addresses apart", async () => {
    const { limiter } = await fixture();
    await attempts(limiter, "a@example.com", 6);

    expect(await limiter.check("b@example.com")).toEqual({ allowed: true });
  });

  it("counts the time left down while the window runs, and lets the next attempt through when it is over", async () => {
    const { limiter, advance } = await fixture();
    await attempts(limiter, "a@example.com", 6);
    advance(10 * 60 * 1000);

    expect(await limiter.check("a@example.com")).toEqual({
      allowed: false,
      retryAfterSeconds: 300,
    });

    advance(SIGN_IN_ACCOUNT_WINDOW_MS);

    expect(await limiter.check("a@example.com")).toEqual({ allowed: true });
  });

  it("starts again after a successful sign in", async () => {
    const { limiter } = await fixture();
    await attempts(limiter, "a@example.com", 5);

    await limiter.succeeded("a@example.com");

    expect(await attempts(limiter, "a@example.com", 5)).toEqual(
      Array(5).fill({ allowed: true }),
    );
  });

  it("stores only a hash of the address", async () => {
    const { db, limiter } = await fixture();
    await limiter.check("secret.person@example.com");

    const keys = (
      await db.selectFrom("rate_limits").select("key").execute()
    ).map((row) => row.key);

    expect(keys).toContain(accountKey("secret.person@example.com"));
    expect(keys.join(" ")).not.toContain("secret.person");
  });
});

describe("the sign in limit for the whole instance", () => {
  // #97-LIMIT
  it("refuses the 101st attempt within a minute, whoever it is for, and allows it after the window", async () => {
    const { limiter, advance } = await fixture();
    for (let attempt = 0; attempt < SIGN_IN_GLOBAL_MAX_ATTEMPTS; attempt += 1)
      expect(
        await limiter.check(`user-${String(attempt)}@example.com`),
      ).toEqual({ allowed: true });

    const refused = await limiter.check("another@example.com");

    expect(refused).toMatchObject({ allowed: false });
    expect(refused.allowed ? 0 : refused.retryAfterSeconds).toBeLessThanOrEqual(
      60,
    );

    advance(SIGN_IN_GLOBAL_WINDOW_MS);

    expect(await limiter.check("another@example.com")).toEqual({
      allowed: true,
    });
  });
});

describe("the sign in limit across app instances", () => {
  // #99-SR-19
  it("counts the failed attempts of two app instances on one database together and answers 429 with Retry-After", async () => {
    const { db, config } = await createTestDatabase();
    // A second app instance: its own connection to the same file, its own limiter, no shared memory.
    const second = track(openDatabase(config));
    const first = createSignInLimiter(createRateLimitsRepository(db));
    const other = createSignInLimiter(createRateLimitsRepository(second));
    const email = "admin@example.com";

    const results = [];
    for (let attempt = 0; attempt < SIGN_IN_ACCOUNT_MAX_ATTEMPTS; attempt += 1)
      results.push(await (attempt % 2 === 0 ? first : other).check(email));
    const refusedByFirst = await first.check(email);
    const refusedBySecond = await other.check(email);

    expect(results.every((result) => result.allowed)).toBe(true);
    expect(refusedByFirst).toMatchObject({ allowed: false });
    expect(refusedBySecond).toEqual(refusedByFirst);
  });

  // #99-SR-19
  it("answers 429 with Retry-After through the HTTP route of whichever instance gets the request", async () => {
    const { db, config } = await createTestDatabase();
    const second = track(openDatabase(config));
    const limiters = [
      createSignInLimiter(createRateLimitsRepository(db)),
      createSignInLimiter(createRateLimitsRepository(second)),
    ];
    const auth = {
      handler: () => Promise.resolve(new Response("{}", { status: 401 })),
    };
    const send = (limiter: (typeof limiters)[number]) =>
      handleAuthRequest(
        auth,
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "admin@example.com",
            password: "wrong-password",
          }),
        }),
        limiter,
      );

    for (let attempt = 0; attempt < SIGN_IN_ACCOUNT_MAX_ATTEMPTS; attempt += 1)
      expect((await send(limiters[attempt % 2]!)).status).toBe(401);
    const refused = await send(limiters[1]!);

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
  });
});
