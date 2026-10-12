// SPDX-License-Identifier: Apache-2.0

// Pins down the limits of the sign-up, the verification mail and the use of a link against the real
// shared counters: a limit per address and for the whole instance, the same for every address, no way
// around them by changing the address, and a link that is only counted when it exists.
import { describe, expect, it } from "vitest";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  createSignUpLimits,
  PASSWORD_RESET_MAIL_GLOBAL_MAX,
  PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
  PASSWORD_RESET_REQUEST_ADDRESS_MAX,
  PASSWORD_RESET_REQUEST_ADDRESS_WINDOW_MS,
  SIGN_UP_ADDRESS_MAX,
  SIGN_UP_ADDRESS_WINDOW_MS,
  SIGN_UP_GLOBAL_KEY,
  SIGN_UP_GLOBAL_MAX,
  VERIFICATION_MAIL_ADDRESS_MAX,
  VERIFICATION_MAIL_ADDRESS_WINDOW_MS,
  VERIFICATION_MAIL_GLOBAL_KEY,
  VERIFICATION_MAIL_GLOBAL_MAX,
  VERIFY_TOKEN_MAX_ATTEMPTS,
  VERIFY_TOKEN_WINDOW_MS,
} from "./limits.ts";

async function fixture() {
  const { db } = await createTestDatabase();
  let time = Date.parse("2026-10-11T08:00:00.000Z");
  const now = () => new Date(time);
  const rateLimits = createRateLimitsRepository(db, now);
  return {
    db,
    rateLimits,
    limits: createSignUpLimits(rateLimits, now),
    advance(ms: number) {
      time += ms;
    },
  };
}

type Limits = Awaited<ReturnType<typeof fixture>>["limits"];

async function repeat(times: number, call: () => ReturnType<Limits["signUp"]>) {
  const results = [];
  for (let i = 0; i < times; i += 1) results.push(await call());
  return results;
}

describe("the sign-up limit", () => {
  // #99-SR-13
  it("lets 10 attempts per hour through for one address and refuses the 11th with the time to wait", async () => {
    const { limits } = await fixture();

    const results = await repeat(11, () => limits.signUp("a@example.com"));

    expect(results.slice(0, SIGN_UP_ADDRESS_MAX)).toEqual(
      Array(SIGN_UP_ADDRESS_MAX).fill({ allowed: true }),
    );
    expect(results[10]).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });

  // #99-SR-13
  it("treats an address nobody owns exactly like a known one", async () => {
    const { limits } = await fixture();

    const known = await repeat(12, () => limits.signUp("a@example.com"));
    const unknown = await repeat(12, () => limits.signUp("nobody@example.com"));

    expect(unknown).toEqual(known);
  });

  it("starts again when the window is over", async () => {
    const { limits, advance } = await fixture();
    await repeat(11, () => limits.signUp("a@example.com"));

    advance(SIGN_UP_ADDRESS_WINDOW_MS);

    expect(await limits.signUp("a@example.com")).toEqual({ allowed: true });
  });

  // #99-SR-13
  it("bounds the whole instance, so changing the address does not avoid the limit", async () => {
    const { limits } = await fixture();

    const results = [];
    for (let i = 0; i < SIGN_UP_GLOBAL_MAX + 1; i += 1)
      results.push(await limits.signUp(`user${String(i)}@example.com`));

    expect(results.slice(0, SIGN_UP_GLOBAL_MAX).every((r) => r.allowed)).toBe(
      true,
    );
    expect(results[SIGN_UP_GLOBAL_MAX]).toMatchObject({ allowed: false });
  });

  it("does not use up the instance limit with attempts beyond the limit of one address", async () => {
    const { limits, rateLimits } = await fixture();

    await repeat(SIGN_UP_ADDRESS_MAX + 20, () =>
      limits.signUp("a@example.com"),
    );

    const global = await rateLimits.hit(SIGN_UP_GLOBAL_KEY, 60_000);
    expect(global.count).toBe(SIGN_UP_ADDRESS_MAX + 1);
  });

  it("keeps the counters of different addresses apart", async () => {
    const { limits } = await fixture();
    await repeat(11, () => limits.signUp("a@example.com"));

    expect(await limits.signUp("b@example.com")).toEqual({ allowed: true });
  });

  it("stores no address, only a hash", async () => {
    const { limits, db } = await fixture();
    await limits.signUp("secret.person@example.com");

    const keys = (
      await db.selectFrom("rate_limits").select("key").execute()
    ).map((row) => row.key);

    expect(keys.join("\n")).not.toContain("secret.person");
  });
});

describe("the verification mail limit", () => {
  // #99-SR-13
  it("lets 5 mails per hour through for one address and refuses the 6th", async () => {
    const { limits } = await fixture();

    const results = await repeat(6, () => limits.mail("a@example.com"));

    expect(
      results.slice(0, VERIFICATION_MAIL_ADDRESS_MAX).every((r) => r.allowed),
    ).toBe(true);
    expect(results[5]).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });

  // #99-SR-13
  it("gives an unknown address the same answers as a known one", async () => {
    const { limits } = await fixture();

    const known = await repeat(8, () => limits.mail("a@example.com"));
    const unknown = await repeat(8, () => limits.mail("zzz@example.com"));

    expect(unknown).toEqual(known);
  });

  it("starts again when the window is over", async () => {
    const { limits, advance } = await fixture();
    await repeat(7, () => limits.mail("a@example.com"));

    advance(VERIFICATION_MAIL_ADDRESS_WINDOW_MS);

    expect(await limits.mail("a@example.com")).toEqual({ allowed: true });
  });

  // #99-SR-13
  it("bounds the mails of the whole instance", async () => {
    const { limits, rateLimits } = await fixture();
    // The instance counter is one row: bring it to its limit without sending 200 mails.
    for (let i = 0; i < VERIFICATION_MAIL_GLOBAL_MAX; i += 1)
      await rateLimits.hit(VERIFICATION_MAIL_GLOBAL_KEY, 10 * 60 * 1000);

    expect(await limits.mail("fresh@example.com")).toMatchObject({
      allowed: false,
    });
  });

  it("is a different counter from the sign-up", async () => {
    const { limits } = await fixture();
    await repeat(11, () => limits.signUp("a@example.com"));

    expect(await limits.mail("a@example.com")).toEqual({ allowed: true });
  });
});

describe("the limit on the use of a link", () => {
  const HASH = "a".repeat(64);

  // #99-SR-12
  it("lets 10 attempts through for one link and refuses the 11th", async () => {
    const { limits } = await fixture();

    const results = [];
    for (let i = 0; i < VERIFY_TOKEN_MAX_ATTEMPTS + 1; i += 1)
      results.push(await limits.verifyToken(HASH));

    expect(
      results.slice(0, VERIFY_TOKEN_MAX_ATTEMPTS).every((r) => r.allowed),
    ).toBe(true);
    expect(results[VERIFY_TOKEN_MAX_ATTEMPTS]).toMatchObject({
      allowed: false,
    });
  });

  // #99-SR-12
  it("never lets the attempts at one link, or at other links, use up the attempts of another link", async () => {
    const { limits } = await fixture();
    for (let i = 0; i < 50; i += 1) await limits.verifyToken("b".repeat(64));
    for (let i = 0; i < 50; i += 1)
      await limits.verifyToken(
        `${String(i).padStart(2, "0")}${"c".repeat(62)}`,
      );

    expect(await limits.verifyToken(HASH)).toEqual({ allowed: true });
  });

  it("counts for the 24 hours a link lives", async () => {
    const { limits, advance } = await fixture();
    for (let i = 0; i < 11; i += 1) await limits.verifyToken(HASH);

    advance(VERIFY_TOKEN_WINDOW_MS - 1000);
    expect(await limits.verifyToken(HASH)).toMatchObject({ allowed: false });
    advance(1000);
    expect(await limits.verifyToken(HASH)).toEqual({ allowed: true });
  });
});

describe("the limits of the reset mail", () => {
  // #100-SM-11
  it("lets 5 requests per hour through for one address and refuses the 6th with the time to wait", async () => {
    const { limits } = await fixture();

    const results = await repeat(6, () => limits.resetRequest("a@example.com"));

    expect(results.slice(0, PASSWORD_RESET_REQUEST_ADDRESS_MAX)).toEqual(
      Array(PASSWORD_RESET_REQUEST_ADDRESS_MAX).fill({ allowed: true }),
    );
    expect(results[5]).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });

  // #100-SM-11
  it("treats an address nobody owns exactly like a known one, and starts again when the window is over", async () => {
    const { limits, advance } = await fixture();

    const known = await repeat(8, () => limits.resetRequest("a@example.com"));
    const unknown = await repeat(8, () =>
      limits.resetRequest("nobody@example.com"),
    );
    advance(PASSWORD_RESET_REQUEST_ADDRESS_WINDOW_MS);

    expect(unknown).toEqual(known);
    expect(await limits.resetRequest("a@example.com")).toEqual({
      allowed: true,
    });
  });

  // #100-SM-11
  it("is not used up by requests for addresses that have no account, which never reach the instance counter", async () => {
    const { limits } = await fixture();
    // A thousand junk requests for a thousand addresses.
    for (let i = 0; i < 1000; i += 1)
      await limits.resetRequest(`junk-${String(i)}@example.com`);

    expect(await limits.resetMail()).toEqual({ allowed: true });
  });

  it("bounds the mails the instance sends for resets, whoever asks", async () => {
    const { limits, advance } = await fixture();

    const results = await repeat(PASSWORD_RESET_MAIL_GLOBAL_MAX + 1, () =>
      limits.resetMail(),
    );

    expect(
      results.slice(0, PASSWORD_RESET_MAIL_GLOBAL_MAX).every((r) => r.allowed),
    ).toBe(true);
    expect(results[PASSWORD_RESET_MAIL_GLOBAL_MAX]).toMatchObject({
      allowed: false,
    });
    advance(PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS);
    expect(await limits.resetMail()).toEqual({ allowed: true });
  });

  it("is a different counter from the verification mail", async () => {
    const { limits } = await fixture();
    await repeat(6, () => limits.mail("a@example.com"));

    expect(await limits.resetRequest("a@example.com")).toEqual({
      allowed: true,
    });
  });
});
