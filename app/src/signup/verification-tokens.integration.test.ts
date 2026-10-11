// SPDX-License-Identifier: Apache-2.0

// Pins down the verification token against a real SQLite file: random and long enough, only its hash is
// stored, valid for 24 hours, used once (also when two requests race), bound to the address it was made
// for, and a refusal changes nothing.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  completeVerification,
  findVerificationToken,
  hashVerificationToken,
  isWellFormedVerificationToken,
  issueVerificationToken,
  newVerificationToken,
  VERIFICATION_TOKEN_TTL_MS,
} from "./verification-tokens.ts";

const START = Date.parse("2026-10-11T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;

async function setup() {
  const { db } = await createTestDatabase();
  for (const [id, email] of [
    ["u1", "a@example.com"],
    ["u2", "b@example.com"],
  ] as const)
    await db
      .insertInto("users")
      .values({
        id,
        name: id,
        email,
        email_verified: 0,
        image: null,
        github_login: null,
        imported_at: null,
        is_instance_admin: 0,
        org_checked_at: null,
        org_checked_for: null,
        created_at: "2026-10-11T08:00:00.000Z",
        updated_at: "2026-10-11T08:00:00.000Z",
      })
      .execute();
  const clock = { time: START };
  const now = () => new Date(clock.time);
  const verified = async (id: string) =>
    (
      await db
        .selectFrom("users")
        .select("email_verified")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).email_verified;
  return { db, clock, now, verified };
}

describe("a verification token", () => {
  // #99-SR-20
  it("is 256 random bits, spelled base64url, and different every time", () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => newVerificationToken()),
    );

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(isWellFormedVerificationToken(token)).toBe(true);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
  });

  it("is not well formed when it is the wrong length, has other characters or is not text", () => {
    for (const value of [
      "",
      "short",
      "x".repeat(44),
      `${"a".repeat(42)}!`,
      5,
      null,
      {},
    ])
      expect(isWellFormedVerificationToken(value)).toBe(false);
  });

  // #99-SR-20
  it("is stored only as its SHA-256 hash", async () => {
    const { db, now } = await setup();

    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    const rows = await db
      .selectFrom("email_verification_tokens")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashVerificationToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("expires 24 hours after it was made", async () => {
    const { db, now } = await setup();

    await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    const row = await db
      .selectFrom("email_verification_tokens")
      .select("expires_at")
      .executeTakeFirstOrThrow();
    expect(Date.parse(row.expires_at) - START).toBe(VERIFICATION_TOKEN_TTL_MS);
    expect(VERIFICATION_TOKEN_TTL_MS).toBe(24 * HOUR);
  });
});

describe("using a verification token", () => {
  // #99-SR-11
  it("verifies the address it was made for", async () => {
    const { db, now, verified } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    const result = await completeVerification(db, token, { now });

    expect(result).toEqual({ ok: true, userId: "u1" });
    expect(await verified("u1")).toBe(1);
    expect(await verified("u2")).toBe(0);
  });

  // #99-SR-12
  it("works just before 24 hours are over and not after", async () => {
    const { db, clock, now, verified } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    clock.time = START + 24 * HOUR;
    const late = await completeVerification(db, token, { now });
    clock.time = START + 24 * HOUR - 1;
    const justInTime = await completeVerification(db, token, { now });

    expect(late).toEqual({ ok: false, error: "token_expired" });
    expect(justInTime).toEqual({ ok: true, userId: "u1" });
    expect(await verified("u1")).toBe(1);
  });

  // #99-SR-12
  it("changes nothing when the link is expired", async () => {
    const { db, clock, now, verified } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });
    const before = await db
      .selectFrom("email_verification_tokens")
      .selectAll()
      .execute();

    clock.time = START + 25 * HOUR;
    const result = await completeVerification(db, token, { now });

    expect(result).toEqual({ ok: false, error: "token_expired" });
    expect(await verified("u1")).toBe(0);
    expect(
      await db.selectFrom("email_verification_tokens").selectAll().execute(),
    ).toEqual(before);
  });

  // #99-SR-12
  it("works once: the second use is refused as used", async () => {
    const { db, now } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    const first = await completeVerification(db, token, { now });
    const second = await completeVerification(db, token, { now });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: "token_used" });
  });

  // #99-SR-12
  it("lets exactly one of two requests with the same link verify", async () => {
    const { db, now } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    const results = await Promise.all([
      completeVerification(db, token, { now }),
      completeVerification(db, token, { now }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: "token_used" },
    ]);
  });

  // #99-SR-12
  it("refuses a tampered or unknown token without touching anything", async () => {
    const { db, now, verified } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    for (const attempt of [
      flipped,
      newVerificationToken(),
      "nonsense",
      "",
      5,
      null,
    ])
      expect(await completeVerification(db, attempt, { now })).toEqual({
        ok: false,
        error: "invalid_token",
      });
    expect(await verified("u1")).toBe(0);
    expect((await findVerificationToken(db, token))?.usedAt).toBeNull();
  });

  // #99-SR-12
  it("verifies only the user the token was made for, never another one", async () => {
    const { db, now, verified } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u2",
      email: "b@example.com",
      now,
    });

    await completeVerification(db, token, { now });

    expect(await verified("u1")).toBe(0);
    expect(await verified("u2")).toBe(1);
  });

  // #99-SR-12
  it("verifies nothing once the account has another address, and the link stays unused", async () => {
    const { db, now, verified } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });
    await db
      .updateTable("users")
      .set({ email: "changed@example.com" })
      .where("id", "=", "u1")
      .execute();

    const result = await completeVerification(db, token, { now });

    expect(result).toEqual({ ok: false, error: "invalid_token" });
    expect(await verified("u1")).toBe(0);
    expect((await findVerificationToken(db, token))?.usedAt).toBeNull();
  });

  it("stops the older link of a user when a new one is made", async () => {
    const { db, now } = await setup();
    const older = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    const newer = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });

    expect(await completeVerification(db, older, { now })).toEqual({
      ok: false,
      error: "invalid_token",
    });
    expect((await completeVerification(db, newer, { now })).ok).toBe(true);
  });

  it("drops the other unused links of the user once the address is verified", async () => {
    const { db, now } = await setup();
    const token = await issueVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      now,
    });
    await db
      .insertInto("email_verification_tokens")
      .values({
        token_hash: "f".repeat(64),
        user_id: "u1",
        email: "a@example.com",
        created_at: "2026-10-11T08:00:00.000Z",
        expires_at: "2026-10-12T08:00:00.000Z",
        used_at: null,
      })
      .execute();

    await completeVerification(db, token, { now });

    const rows = await db
      .selectFrom("email_verification_tokens")
      .select("used_at")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.used_at).not.toBeNull();
  });
});
