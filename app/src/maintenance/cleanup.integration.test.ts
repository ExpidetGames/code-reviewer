// SPDX-License-Identifier: Apache-2.0

// Pins down the cleanup of old rows against a real SQLite file: counters whose window is over and
// verification links that expired or were used a week ago go, everything that still has an effect stays,
// and the one window it relies on is at least as long as every window the app counts.
import { describe, expect, it } from "vitest";
import { PASSWORD_RESET_WINDOW_MS } from "../auth/password-reset-http.ts";
import {
  SIGN_IN_ACCOUNT_WINDOW_MS,
  SIGN_IN_GLOBAL_WINDOW_MS,
} from "../auth/sign-in-limit.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
  PASSWORD_RESET_REQUEST_ADDRESS_WINDOW_MS,
  SIGN_UP_ADDRESS_WINDOW_MS,
  SIGN_UP_GLOBAL_WINDOW_MS,
  VERIFICATION_MAIL_ADDRESS_WINDOW_MS,
  VERIFICATION_MAIL_GLOBAL_WINDOW_MS,
  VERIFY_TOKEN_WINDOW_MS,
} from "../signup/limits.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  cleanUpExpiredRows,
  LONGEST_RATE_LIMIT_WINDOW_MS,
  PASSWORD_RESET_TOKEN_KEEP_MS,
  VERIFICATION_TOKEN_KEEP_MS,
} from "./cleanup.ts";

const START = Date.parse("2026-10-11T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

async function setup() {
  const { db } = await createTestDatabase();
  await db
    .insertInto("users")
    .values({
      id: "u1",
      name: "u1",
      email: "a@example.com",
      email_verified: 0,
      image: null,
      github_login: null,
      imported_at: null,
      is_instance_admin: 0,
      org_checked_at: null,
      org_checked_for: null,
      created_at: iso(START),
      updated_at: iso(START),
    })
    .execute();
  const clock = { time: START };
  const now = () => new Date(clock.time);
  const token = (
    hash: string,
    expiresAt: number,
    usedAt: number | null = null,
  ) =>
    db
      .insertInto("email_verification_tokens")
      .values({
        token_hash: hash,
        user_id: "u1",
        email: "a@example.com",
        password_hash: "h",
        created_at: iso(START - 30 * DAY),
        expires_at: iso(expiresAt),
        used_at: usedAt === null ? null : iso(usedAt),
      })
      .execute();
  return { db, clock, now, token };
}

describe("the cleanup of old rows", () => {
  it("removes the counters whose window is over and keeps those in force", async () => {
    const { db, clock, now } = await setup();
    const early = createRateLimitsRepository(
      db,
      () => new Date(START - 2 * DAY),
    );
    await early.hit("old", 60_000);
    const repository = createRateLimitsRepository(db, now);
    await repository.hit("fresh", 60_000);
    clock.time = START + 60_000;

    const result = await cleanUpExpiredRows(db, now);

    expect(result.rateLimits).toBe(1);
    expect(
      (await db.selectFrom("rate_limits").select("key").execute()).map(
        (row) => row.key,
      ),
    ).toEqual(["fresh"]);
  });

  it("keeps a counter with the longest window until that window is over", async () => {
    const { db, clock, now } = await setup();
    await createRateLimitsRepository(db, now).hit(
      "link",
      LONGEST_RATE_LIMIT_WINDOW_MS,
    );

    clock.time = START + LONGEST_RATE_LIMIT_WINDOW_MS - 1;
    const before = await cleanUpExpiredRows(db, now);
    clock.time = START + LONGEST_RATE_LIMIT_WINDOW_MS;
    const after = await cleanUpExpiredRows(db, now);

    expect(before.rateLimits).toBe(0);
    expect(after.rateLimits).toBe(1);
  });

  it("relies on a window at least as long as every window the app counts", () => {
    for (const window of [
      SIGN_IN_ACCOUNT_WINDOW_MS,
      SIGN_IN_GLOBAL_WINDOW_MS,
      PASSWORD_RESET_WINDOW_MS,
      SIGN_UP_ADDRESS_WINDOW_MS,
      SIGN_UP_GLOBAL_WINDOW_MS,
      VERIFICATION_MAIL_ADDRESS_WINDOW_MS,
      VERIFICATION_MAIL_GLOBAL_WINDOW_MS,
      VERIFY_TOKEN_WINDOW_MS,
      PASSWORD_RESET_REQUEST_ADDRESS_WINDOW_MS,
      PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
    ])
      expect(window).toBeLessThanOrEqual(LONGEST_RATE_LIMIT_WINDOW_MS);
  });

  it("removes verification links that expired or were used a week ago, and keeps the rest", async () => {
    const { db, now, token } = await setup();
    const keep = VERIFICATION_TOKEN_KEEP_MS;
    await token("expired-long-ago", START - keep - 1);
    await token("expired-just-now", START - keep + 1000);
    await token("used-long-ago", START + DAY, START - keep - 1);
    await token("used-recently", START + DAY, START - DAY);
    await token("pending", START + DAY);

    const result = await cleanUpExpiredRows(db, now);

    expect(result.verificationTokens).toBe(2);
    expect(
      (
        await db
          .selectFrom("email_verification_tokens")
          .select("token_hash")
          .orderBy("token_hash")
          .execute()
      ).map((row) => row.token_hash),
    ).toEqual(["expired-just-now", "pending", "used-recently"]);
  });

  // #100-SM-12
  it("removes reset links that expired or were used a week ago, and keeps the rest", async () => {
    const { db, now } = await setup();
    const keep = PASSWORD_RESET_TOKEN_KEEP_MS;
    const link = (hash: string, expiresAt: number, usedAt: number | null = null) =>
      db
        .insertInto("password_reset_tokens")
        .values({
          token_hash: hash,
          user_id: "u1",
          created_at: iso(START - 30 * DAY),
          expires_at: iso(expiresAt),
          used_at: usedAt === null ? null : iso(usedAt),
        })
        .execute();
    await link("expired-long-ago", START - keep - 1);
    await link("expired-just-now", START - keep + 1000);
    await link("used-long-ago", START + DAY, START - keep - 1);
    await link("used-recently", START + DAY, START - DAY);
    await link("pending", START + 1000);

    const result = await cleanUpExpiredRows(db, now);

    expect(result.passwordResetTokens).toBe(2);
    expect(
      (
        await db
          .selectFrom("password_reset_tokens")
          .select("token_hash")
          .orderBy("token_hash")
          .execute()
      ).map((row) => row.token_hash),
    ).toEqual(["expired-just-now", "pending", "used-recently"]);
  });

  it("does nothing on an empty database", async () => {
    const { db, now } = await setup();

    expect(await cleanUpExpiredRows(db, now)).toEqual({
      rateLimits: 0,
      verificationTokens: 0,
      passwordResetTokens: 0,
    });
  });
});
