// SPDX-License-Identifier: LicenseRef-Proprietary

// The exact end of a password reset link: it works up to the last millisecond and not at 30:00. The
// link is checked twice, by the look before the slow part of the reset (`expires_at <= now` refuses) and
// by the statement that uses it up (`expires_at > now` is needed), and each of the two has to hold the
// boundary by itself. A clock that stands still cannot tell them apart (one that is wrong is refused by
// the other), so the clock here answers a different instant to each: the first call is the look, the
// second the statement.
import { describe, expect, it } from "vitest";
import { hashResetToken, RESET_TOKEN_TTL_MS } from "../auth/link-token.ts";
import { makeResetLink } from "../test-support/reset-link.ts";
import {
  createAdminHarness,
  ADMIN_TEST_BASE_URL,
  ADMIN_TEST_CREDENTIALS,
} from "../test-support/admin-harness.ts";
import { completePasswordReset } from "./password-reset.ts";

const NEW_PASSWORD = "n3w-Passphrase-orbit-lantern";
const MADE_AT = new Date("2026-10-11T12:00:00.000Z");
const EXPIRES_AT = new Date(MADE_AT.getTime() + 30 * 60 * 1000);
const LAST_MOMENT = new Date(EXPIRES_AT.getTime() - 1);

async function aLinkMadeByTheOperator() {
  const portal = await createAdminHarness();
  const made = await makeResetLink(portal.db, {
    email: ADMIN_TEST_CREDENTIALS.email,
    baseUrl: ADMIN_TEST_BASE_URL,
    now: () => MADE_AT,
  });
  expect(made.ok).toBe(true);
  const token = made.ok ? made.token : "";
  const hash = (await portal.auth.$context).password.hash;

  /**
   * Uses the link with a clock that answers `instants` one after the other (the last one from then on).
   * `clockCalls` is how often it was asked: the tests rely on the look and then the statement, so on exactly
   * two (one, when the look refuses the link), so a change that asks a third time cannot silently turn them into tests of something else.
   */
  async function useTheLink(...instants: Date[]) {
    let clockCalls = 0;
    const now = () =>
      instants[Math.min(clockCalls++, instants.length - 1)] as Date;
    const result = await completePasswordReset(
      { db: portal.db, hashPassword: hash, now },
      { token, password: NEW_PASSWORD },
    );
    return { result, clockCalls };
  }

  async function theLinkInTheDatabase() {
    return portal.db
      .selectFrom("password_reset_tokens")
      .select(["created_at", "expires_at", "used_at"])
      .where("token_hash", "=", hashResetToken(token))
      .executeTakeFirstOrThrow();
  }

  async function passwordHash() {
    const row = await portal.db
      .selectFrom("accounts")
      .select("password")
      .where("user_id", "=", portal.adminId)
      .where("provider_id", "=", "credential")
      .executeTakeFirstOrThrow();
    return row.password;
  }

  return { useTheLink, theLinkInTheDatabase, passwordHash };
}

describe("the end of a password reset link", () => {
  // #138
  it("is 30 minutes after the link was made", async () => {
    const { theLinkInTheDatabase } = await aLinkMadeByTheOperator();

    const link = await theLinkInTheDatabase();

    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    expect(link.created_at).toBe(MADE_AT.toISOString());
    expect(link.expires_at).toBe(EXPIRES_AT.toISOString());
  });

  // #138
  it("lets the link work in the last millisecond before it", async () => {
    const { useTheLink, theLinkInTheDatabase } = await aLinkMadeByTheOperator();

    const { result, clockCalls } = await useTheLink(LAST_MOMENT, LAST_MOMENT);

    expect(clockCalls).toBe(2);
    expect(result).toEqual({ ok: true });
    expect((await theLinkInTheDatabase()).used_at).toBe(
      LAST_MOMENT.toISOString(),
    );
  });

  // #138
  it("is refused by the look before the reset when it is exactly 30:00 then, even if the statement would still accept it", async () => {
    const { useTheLink, theLinkInTheDatabase, passwordHash } =
      await aLinkMadeByTheOperator();
    const before = await passwordHash();

    const { result, clockCalls } = await useTheLink(EXPIRES_AT, LAST_MOMENT);

    expect(clockCalls).toBe(1);
    expect(result).toEqual({ ok: false, error: "invalid_token" });
    expect((await theLinkInTheDatabase()).used_at).toBeNull();
    expect(await passwordHash()).toBe(before);
  });

  // #138
  it("is refused by the statement that uses the link up when it is exactly 30:00 then, even if the look let it pass", async () => {
    const { useTheLink, theLinkInTheDatabase, passwordHash } =
      await aLinkMadeByTheOperator();
    const before = await passwordHash();

    const { result, clockCalls } = await useTheLink(LAST_MOMENT, EXPIRES_AT);

    expect(clockCalls).toBe(2);
    expect(result).toEqual({ ok: false, error: "invalid_token" });
    expect((await theLinkInTheDatabase()).used_at).toBeNull();
    expect(await passwordHash()).toBe(before);
  });
});
