// SPDX-License-Identifier: Apache-2.0

// Pins down the expiry of sign-ups that never verified their address, against a real SQLite file: the
// account, its password account and its pending links go after a week; everything that is more than such a
// sign-up (a verified address, the admin, an imported user, a member of a workspace, someone signed in, a
// GitHub identity) stays, and so does everything while the instance cannot verify by mail. A new sign-up
// for an address whose pending account was removed is an ordinary sign-up.
import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { CREDENTIAL_PROVIDER_ID } from "../auth/session-user.ts";
import type { Database } from "../db/schema.ts";
import {
  createSignUpHarness,
  SIGNUP_TEST_PASSWORD,
} from "../test-support/signup-harness.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { cleanUpExpiredRows, UNVERIFIED_ACCOUNT_KEEP_MS } from "./cleanup.ts";

const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = () => new Date(NOW);
const MAIL = { mailConfigured: () => Promise.resolve(true) };

type Person = {
  id: string;
  /** When the sign-up happened. Default: a week and a second ago. */
  createdAt?: number;
  verified?: boolean;
  admin?: boolean;
  importedAt?: number | null;
  /** Rows of other tables that make the account more than a pending sign-up. */
  member?: boolean;
  session?: boolean;
  github?: boolean;
  /** Without a password account (a user Better Auth made for another way to sign in). */
  noPassword?: boolean;
  /** When the links of the sign-up were made; none for an empty list. Default: at the sign-up. */
  links?: number[];
};

const EXPIRED_AT = NOW - UNVERIFIED_ACCOUNT_KEEP_MS - 1000;

async function addPerson(db: Kysely<Database>, person: Person): Promise<void> {
  const createdAt = person.createdAt ?? EXPIRED_AT;
  const email = `${person.id}@example.com`;
  await db
    .insertInto("users")
    .values({
      id: person.id,
      name: person.id,
      email,
      email_verified: person.verified === true ? 1 : 0,
      image: null,
      github_login: person.github === true ? person.id : null,
      imported_at:
        person.importedAt === undefined || person.importedAt === null
          ? null
          : iso(person.importedAt),
      is_instance_admin: person.admin === true ? 1 : 0,
      org_checked_at: null,
      org_checked_for: null,
      created_at: iso(createdAt),
      updated_at: iso(createdAt),
    })
    .execute();
  const account = (providerId: string, password: string | null) =>
    db
      .insertInto("accounts")
      .values({
        id: `${person.id}-${providerId}`,
        account_id: providerId === "github" ? "583231" : person.id,
        provider_id: providerId,
        user_id: person.id,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password,
        created_at: iso(createdAt),
        updated_at: iso(createdAt),
      })
      .execute();
  if (person.noPassword !== true) await account(CREDENTIAL_PROVIDER_ID, "hash");
  if (person.github === true) await account("github", null);
  for (const [index, madeAt] of (person.links ?? [createdAt]).entries()) {
    await db
      .insertInto("email_verification_tokens")
      .values({
        token_hash: `${person.id}-link-${String(index)}`,
        user_id: person.id,
        email,
        password_hash: "hash",
        created_at: iso(madeAt),
        expires_at: iso(madeAt + DAY),
        used_at: null,
      })
      .execute();
  }
  await db
    .insertInto("password_reset_tokens")
    .values({
      token_hash: `${person.id}-reset`,
      user_id: person.id,
      created_at: iso(createdAt),
      expires_at: iso(createdAt + 1_800_000),
      used_at: null,
    })
    .execute();
  if (person.member === true) {
    await db
      .insertInto("workspaces")
      .values({
        id: `${person.id}-workspace`,
        name: "Team",
        slug: `${person.id}-team`,
        created_by: null,
        created_at: iso(createdAt),
      })
      .execute();
    await db
      .insertInto("workspace_members")
      .values({
        workspace_id: `${person.id}-workspace`,
        user_id: person.id,
        role: "member",
        created_at: iso(createdAt),
      })
      .execute();
  }
  if (person.session === true)
    await db
      .insertInto("sessions")
      .values({
        id: `${person.id}-session`,
        expires_at: iso(NOW + DAY),
        token: `${person.id}-token`,
        created_at: iso(createdAt),
        updated_at: iso(createdAt),
        ip_address: null,
        user_agent: null,
        user_id: person.id,
      })
      .execute();
}

async function userIds(db: Kysely<Database>): Promise<string[]> {
  return (
    await db.selectFrom("users").select("id").orderBy("id").execute()
  ).map((row) => row.id);
}

describe("the expiry of sign-ups that never verified their address", () => {
  // #141
  it("waits a week", () => {
    expect(UNVERIFIED_ACCOUNT_KEEP_MS).toBe(7 * DAY);
  });

  // #141
  it("removes a pending sign-up older than a week together with its password account and its links", async () => {
    const { db } = await createTestDatabase();
    await addPerson(db, {
      id: "pending",
      links: [EXPIRED_AT - DAY, EXPIRED_AT],
    });

    const result = await cleanUpExpiredRows(db, now, MAIL);

    expect(result.unverifiedAccounts).toBe(1);
    expect(await userIds(db)).toEqual([]);
    for (const table of [
      "accounts",
      "email_verification_tokens",
      "password_reset_tokens",
    ] as const)
      expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
  });

  // #141
  it("keeps a sign-up that is exactly a week old and removes it a moment later", async () => {
    const { db } = await createTestDatabase();
    await addPerson(db, {
      id: "exactly",
      createdAt: NOW - UNVERIFIED_ACCOUNT_KEEP_MS,
    });
    await addPerson(db, {
      id: "later",
      createdAt: NOW - UNVERIFIED_ACCOUNT_KEEP_MS - 1,
    });

    await cleanUpExpiredRows(db, now, MAIL);

    expect(await userIds(db)).toEqual(["exactly"]);
  });

  it("keeps a younger sign-up", async () => {
    const { db } = await createTestDatabase();
    await addPerson(db, { id: "young", createdAt: NOW - 6 * DAY });

    const result = await cleanUpExpiredRows(db, now, MAIL);

    expect(result.unverifiedAccounts).toBe(0);
    expect(await userIds(db)).toEqual(["young"]);
  });

  // #141
  it.each<[string, Person]>([
    ["an address that was verified", { id: "x", verified: true }],
    ["the instance admin", { id: "x", admin: true }],
    ["an imported user", { id: "x", importedAt: NOW - 30 * DAY }],
    ["a member of a workspace", { id: "x", member: true }],
    ["someone with a session", { id: "x", session: true }],
    ["an account with a GitHub identity", { id: "x", github: true }],
    ["a user without a password account", { id: "x", noPassword: true }],
    [
      "a user who signs in with GitHub only",
      { id: "x", noPassword: true, github: true },
    ],
    [
      "a sign-up that was never asked to verify (no link)",
      { id: "x", links: [] },
    ],
    [
      "a sign-up that was sent a link within the last week",
      { id: "x", links: [EXPIRED_AT, NOW - DAY] },
    ],
  ])("never removes %s", async (_name, person) => {
    const { db } = await createTestDatabase();
    await addPerson(db, person);
    await addPerson(db, { id: "expired" });

    const result = await cleanUpExpiredRows(db, now, MAIL);

    expect(result.unverifiedAccounts).toBe(1);
    expect(await userIds(db)).toEqual(["x"]);
    // Whatever belongs to the account stays too.
    expect(
      (await db.selectFrom("accounts").select("user_id").execute()).every(
        (row) => row.user_id === "x",
      ),
    ).toBe(true);
  });

  // #141
  it("removes nothing while the instance cannot verify by mail, and nothing unless it is asked", async () => {
    const { db } = await createTestDatabase();
    await addPerson(db, { id: "pending" });

    const without = await cleanUpExpiredRows(db, now, {
      mailConfigured: () => Promise.resolve(false),
    });
    const unasked = await cleanUpExpiredRows(db, now);
    const failing = await cleanUpExpiredRows(db, now, {
      mailConfigured: () => Promise.reject(new Error("no settings")),
    });

    expect([
      without.unverifiedAccounts,
      unasked.unverifiedAccounts,
      failing.unverifiedAccounts,
    ]).toEqual([0, 0, 0]);
    expect(await userIds(db)).toEqual(["pending"]);
  });

  // #141
  it("removes the pending sign-ups and leaves a verified account of the same age in a mixed set", async () => {
    const { db } = await createTestDatabase();
    await addPerson(db, { id: "a-verified", verified: true });
    await addPerson(db, { id: "b-pending" });
    await addPerson(db, { id: "c-member", member: true });
    await addPerson(db, { id: "d-pending" });

    await cleanUpExpiredRows(db, now, MAIL);

    expect(await userIds(db)).toEqual(["a-verified", "c-member"]);
  });

  // #141
  it("lets a person sign up again for an address whose pending account was removed, as if it was new", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const address = "newcomer@example.com";
    await harness.signUp({ email: address, password: SIGNUP_TEST_PASSWORD });
    await harness.flush();
    const first = await harness.user(address);
    const oldToken = harness.mail.lastToken(address);
    harness.advance(UNVERIFIED_ACCOUNT_KEEP_MS + 1000);

    const result = await cleanUpExpiredRows(harness.db, harness.now, MAIL);
    expect(result.unverifiedAccounts).toBe(1);
    expect(await harness.user(address)).toBeUndefined();
    // The instance admin is not touched.
    expect(await harness.user(harness.admin.email)).toBeDefined();

    const newPassword = "t7Hn-w2Qz9Lc-second";
    const answer = await harness.signUp({
      email: address,
      password: newPassword,
    });
    await harness.flush();

    expect(answer.status).toBe(200);
    const second = await harness.user(address);
    expect(second?.id).not.toBe(first?.id);
    expect(second).toMatchObject({ email_verified: 0 });
    expect(harness.mail.to(address)).toHaveLength(2);
    // The old link is gone with the old account; the new one verifies the new account with the new password.
    const stale = await harness.verify({
      token: oldToken,
      password: SIGNUP_TEST_PASSWORD,
    });
    expect(stale.status).toBe(400);
    const fresh = await harness.verify({
      token: harness.mail.lastToken(address),
      password: newPassword,
    });
    expect(fresh.status).toBe(200);
    expect(await harness.user(address)).toMatchObject({ email_verified: 1 });
  });
});
