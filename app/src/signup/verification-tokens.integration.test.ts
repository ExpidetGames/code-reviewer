// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the verification token against a real Postgres database: random and long enough, only its hash is
// stored, valid for 24 hours, used once (also when two requests race), bound to the address and to the
// password of the sign-up that made it, and a refusal changes nothing. A link is used with that password,
// and then that password is the password of the account and no other link of the account works.
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
  type VerifyPassword,
} from "./verification-tokens.ts";

const START = Date.parse("2026-10-11T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;

// A password check for tests: a hash is "hash-of:<password>".
const verifyPassword: VerifyPassword = ({ hash, password }) =>
  Promise.resolve(hash === `hash-of:${password}`);
const hashOf = (password: string) => `hash-of:${password}`;

async function setup() {
  const { db } = await createTestDatabase();
  for (const [id, email] of [
    ["u1", "a@example.com"],
    ["u2", "b@example.com"],
  ] as const) {
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
    await db
      .insertInto("accounts")
      .values({
        id: `acc-${id}`,
        account_id: id,
        provider_id: "credential",
        user_id: id,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: hashOf("first-password"),
        created_at: "2026-10-11T08:00:00.000Z",
        updated_at: "2026-10-11T08:00:00.000Z",
      })
      .execute();
  }
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
  const passwordOf = async (id: string) =>
    (
      await db
        .selectFrom("accounts")
        .select("password")
        .where("user_id", "=", id)
        .executeTakeFirstOrThrow()
    ).password;
  const issue = (
    password = "first-password",
    userId = "u1",
    email = "a@example.com",
  ) =>
    issueVerificationToken(db, {
      userId,
      email,
      passwordHash: hashOf(password),
      now,
    });
  // The password defaults to the one of `issue()`; `undefined` is passed on as it is.
  const use = (token: unknown, ...password: [] | [password: unknown]) =>
    completeVerification(
      db,
      token,
      password.length === 0 ? "first-password" : password[0],
      { verifyPassword, now },
    );
  return { db, clock, now, verified, passwordOf, issue, use };
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
    const { db, issue } = await setup();

    const token = await issue();

    const rows = await db
      .selectFrom("email_verification_tokens")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashVerificationToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("expires 24 hours after it was made", async () => {
    const { db, issue } = await setup();

    await issue();

    const row = await db
      .selectFrom("email_verification_tokens")
      .select("expires_at")
      .executeTakeFirstOrThrow();
    expect(Date.parse(row.expires_at) - START).toBe(VERIFICATION_TOKEN_TTL_MS);
    expect(VERIFICATION_TOKEN_TTL_MS).toBe(24 * HOUR);
  });

  it("does not cancel the links that are pending already", async () => {
    const { issue, use } = await setup();
    const older = await issue("first-password");

    await issue("second-password");

    expect((await use(older, "first-password")).ok).toBe(true);
  });
});

describe("using a verification token", () => {
  // #99-SR-11
  it("verifies the address and only that address", async () => {
    const { issue, use, verified } = await setup();
    const token = await issue();

    const result = await use(token);

    expect(result).toEqual({ ok: true, userId: "u1" });
    expect(await verified("u1")).toBe(1);
    expect(await verified("u2")).toBe(0);
  });

  // #99-SR-12
  it("works just before 24 hours are over and not after", async () => {
    const { clock, issue, use, verified } = await setup();
    const token = await issue();

    clock.time = START + 24 * HOUR;
    const late = await use(token);
    clock.time = START + 24 * HOUR - 1;
    const justInTime = await use(token);

    expect(late).toEqual({ ok: false, error: "token_expired" });
    expect(justInTime).toEqual({ ok: true, userId: "u1" });
    expect(await verified("u1")).toBe(1);
  });

  // #99-SR-12
  it("changes nothing when the link is expired", async () => {
    const { db, clock, issue, use, verified } = await setup();
    const token = await issue();
    const before = await db
      .selectFrom("email_verification_tokens")
      .selectAll()
      .execute();

    clock.time = START + 25 * HOUR;
    const result = await use(token);

    expect(result).toEqual({ ok: false, error: "token_expired" });
    expect(await verified("u1")).toBe(0);
    expect(
      await db.selectFrom("email_verification_tokens").selectAll().execute(),
    ).toEqual(before);
  });

  // #99-SR-12
  it("works once: the second use is refused as used", async () => {
    const { issue, use } = await setup();
    const token = await issue();

    const first = await use(token);
    const second = await use(token);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: "token_used" });
  });

  // #99-SR-12
  it("lets exactly one of two requests with the same link verify", async () => {
    const { issue, use } = await setup();
    const token = await issue();

    const results = await Promise.all([use(token), use(token)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: "token_used" },
    ]);
  });

  // #99-SR-12
  it("refuses a tampered or unknown token without touching anything", async () => {
    const { db, issue, use, verified } = await setup();
    const token = await issue();
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    for (const attempt of [
      flipped,
      newVerificationToken(),
      "nonsense",
      "",
      5,
      null,
    ])
      expect(await use(attempt)).toEqual({ ok: false, error: "invalid_token" });
    expect(await verified("u1")).toBe(0);
    expect((await findVerificationToken(db, token))?.usedAt).toBeNull();
  });

  // #99-SR-12
  it("verifies only the user the token was made for, never another one", async () => {
    const { issue, use, verified } = await setup();
    const token = await issue("first-password", "u2", "b@example.com");

    await use(token);

    expect(await verified("u1")).toBe(0);
    expect(await verified("u2")).toBe(1);
  });

  // #99-SR-12
  it("verifies nothing once the account has another address, and the link stays unused", async () => {
    const { db, issue, use, verified } = await setup();
    const token = await issue();
    await db
      .updateTable("users")
      .set({ email: "changed@example.com" })
      .where("id", "=", "u1")
      .execute();

    const result = await use(token);

    expect(result).toEqual({ ok: false, error: "invalid_token" });
    expect(await verified("u1")).toBe(0);
    expect((await findVerificationToken(db, token))?.usedAt).toBeNull();
  });

  it("verifies nothing for an account that is verified already", async () => {
    const { db, issue, use, passwordOf } = await setup();
    const token = await issue("other-password");
    await db.updateTable("users").set({ email_verified: 1 }).execute();

    const result = await use(token, "other-password");

    expect(result).toEqual({ ok: false, error: "invalid_token" });
    expect(await passwordOf("u1")).toBe(hashOf("first-password"));
  });
});

describe("the password of a verification token", () => {
  // #99-SR-12
  it("is needed: a wrong password, none and a password of another type are one answer with the unknown token, and nothing changes", async () => {
    const { db, issue, use, verified } = await setup();
    const token = await issue("first-password");
    const answers = [
      await use(token, "wrong-password"),
      await use(token, ""),
      await use(token, undefined),
      await use(token, 5),
      await use(newVerificationToken(), "first-password"),
    ];

    expect(answers).toEqual(
      Array(5).fill({ ok: false, error: "invalid_token" }),
    );
    expect(await verified("u1")).toBe(0);
    expect((await findVerificationToken(db, token))?.usedAt).toBeNull();
  });

  // #99-SR-12
  it("does not reveal that a link is used or expired to somebody who does not have the password", async () => {
    const { clock, issue, use } = await setup();
    const used = await issue("first-password");
    await use(used, "first-password");
    const expired = await issue("first-password", "u2", "b@example.com");
    clock.time = START + 25 * HOUR;

    expect(await use(used, "wrong-password")).toEqual({
      ok: false,
      error: "invalid_token",
    });
    expect(await use(expired, "wrong-password")).toEqual({
      ok: false,
      error: "invalid_token",
    });
  });

  // #99-SR-12
  it("becomes the password of the account when the link is used", async () => {
    const { issue, use, passwordOf } = await setup();
    const token = await issue("the-sign-up-password");

    await use(token, "the-sign-up-password");

    expect(await passwordOf("u1")).toBe(hashOf("the-sign-up-password"));
  });

  // #99-SR-12
  it("ends the sessions of the account when its password changes, and keeps them when it does not", async () => {
    const { db, issue, use } = await setup();
    const session = (id: string, userId: string) =>
      db
        .insertInto("sessions")
        .values({
          id,
          expires_at: "2026-11-11T08:00:00.000Z",
          token: `token-${id}`,
          created_at: "2026-10-11T08:00:00.000Z",
          updated_at: "2026-10-11T08:00:00.000Z",
          ip_address: null,
          user_agent: null,
          user_id: userId,
        })
        .execute();
    await session("s1", "u1");
    await session("s2", "u2");

    await use(await issue("first-password", "u2", "b@example.com"));
    const kept = await db.selectFrom("sessions").select("user_id").execute();
    await use(await issue("new-password"), "new-password");
    const left = await db.selectFrom("sessions").select("user_id").execute();

    expect(kept.map((row) => row.user_id).sort()).toEqual(["u1", "u2"]);
    expect(left.map((row) => row.user_id)).toEqual(["u2"]);
  });

  // #99-SR-12
  it("cancels every other pending link of the account, and not those of another account", async () => {
    const { db, issue, use } = await setup();
    const mine = await issue("first-password");
    const attackers = await issue("attacker-password");
    const other = await issue("first-password", "u2", "b@example.com");

    await use(mine, "first-password");

    // The rows are gone, not just refused: nothing of the account is pending any more.
    const pending = await db
      .selectFrom("email_verification_tokens")
      .select(["user_id", "used_at"])
      .where("used_at", "is", null)
      .execute();
    expect(pending).toEqual([{ user_id: "u2", used_at: null }]);

    expect(await use(attackers, "attacker-password")).toEqual({
      ok: false,
      error: "invalid_token",
    });
    expect((await use(other, "first-password")).ok).toBe(true);
  });
});
