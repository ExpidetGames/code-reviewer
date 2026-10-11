// SPDX-License-Identifier: Apache-2.0

// Pins down the limit on email and password sign in attempts against the real shared counters:
// about 5 attempts per 15 minutes per email address, the same for an address nobody owns, a
// generous limit for the whole instance, and a fresh start after a success or the end of the window.
import { describe, expect, it } from "vitest";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
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
