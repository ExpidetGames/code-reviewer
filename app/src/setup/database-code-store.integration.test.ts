// SPDX-License-Identifier: Apache-2.0

// The setup code of a serverless deployment, kept in the database so every instance sees the same
// code and the same counters (#321). Every test here makes "another instance" by building a second
// store over the same database: nothing is shared between two stores but the rows. The Postgres
// variant at the end repeats the races on a real server and runs only when TEST_DATABASE_URL is set.
import { describe, expect, it } from "vitest";
import { createSetupCodesRepository } from "../db/repositories/setup-codes-repository.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  SETUP_ATTEMPT_WINDOW_MS,
  SETUP_ATTEMPTS_PER_WINDOW,
  SETUP_CODE_TTL_MS,
  SETUP_MAX_FAILURES,
} from "./code-store.ts";
import { createDatabaseSetupCodeStore } from "./database-code-store.ts";

const SECRET = "database-code-store-secret-0123456789-0123456789";
const CODE = "482913";

type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];

function clock() {
  let time = Date.parse("2026-10-15T08:00:00.000Z");
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

/** One app instance: its own store (and nothing else in memory) over the shared database. */
function instance(
  db: Db,
  time: ReturnType<typeof clock>,
  options: { secret?: string; code?: string } = {},
) {
  return createDatabaseSetupCodeStore({
    db,
    appSecret: options.secret ?? SECRET,
    now: time.now,
    randomCode: () => options.code ?? CODE,
  });
}

async function wrongAttempts(
  store: ReturnType<typeof instance>,
  time: ReturnType<typeof clock>,
  count: number,
) {
  const results = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    results.push(await store.attempt("000000"));
    // Stays under the rate limit, so only the lock can stop it.
    time.advance(SETUP_ATTEMPT_WINDOW_MS);
  }
  return results;
}

describe("the database backed setup code", () => {
  // #321-T01
  it("is issued by one instance and accepted by another, which then binds the session to the issuance", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const issuing = instance(db, time);
    const other = instance(db, time);

    const issued = await issuing.issue();
    const result = await other.attempt(CODE);

    expect(issued.code).toBe(CODE);
    expect(result).toEqual({ ok: true, issueId: issued.issueId });
    expect(await other.currentIssueId()).toBe(issued.issueId);
    expect(await instance(db, time).currentIssueId()).toBe(issued.issueId);
  });

  // #321-T01
  it("answers setup_unavailable until a code was issued, and has no issuance", async () => {
    const { db } = await createTestDatabase();
    const store = instance(db, clock());

    expect(await store.attempt(CODE)).toEqual({
      ok: false,
      error: "setup_unavailable",
    });
    expect(await store.currentIssueId()).toBeNull();
  });

  // #321-T01
  it("refuses a wrong code the way the in-memory store does, without saying how close it was", async () => {
    const { db } = await createTestDatabase();
    const store = instance(db, clock());
    await store.issue();

    const result = await store.attempt("482914");

    expect(result).toEqual({ ok: false, error: "invalid_code" });
    expect(JSON.stringify(result)).not.toMatch(/\d{6}|4829|2913/);
  });

  // #321-T01
  it("treats anything that is not a string like a wrong code", async () => {
    const { db } = await createTestDatabase();
    const store = instance(db, clock());
    await store.issue();

    expect(await store.attempt(undefined)).toEqual({
      ok: false,
      error: "invalid_code",
    });
    expect(await store.attempt({ code: CODE })).toEqual({
      ok: false,
      error: "invalid_code",
    });
    expect(await store.attempt(` ${CODE} `)).toMatchObject({ ok: true });
  });

  // #321-T01
  it("issues a new code that replaces the old one and ends the old issuance", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const first = await instance(db, time, { code: "111111" }).issue();
    const second = await instance(db, time, { code: "222222" }).issue();

    const store = instance(db, time);
    expect(second.issueId).not.toBe(first.issueId);
    expect(await store.currentIssueId()).toBe(second.issueId);
    expect(await store.attempt("111111")).toEqual({
      ok: false,
      error: "invalid_code",
    });
    expect(await store.attempt("222222")).toMatchObject({ ok: true });
    expect(
      await db.selectFrom("setup_codes").select("id").execute(),
    ).toHaveLength(1);
  });

  // #321-T01
  it("forgets the code and the issuance when the setup is complete", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const store = instance(db, time);
    await store.issue();
    await store.attempt(CODE);

    await instance(db, time).invalidate();

    expect(await store.currentIssueId()).toBeNull();
    expect(await store.attempt(CODE)).toEqual({
      ok: false,
      error: "setup_unavailable",
    });
  });
});

describe("single use across instances", () => {
  // #321-T03
  it("accepts a correct code once; the same instance and another one then answer code_used", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const first = instance(db, time);
    const second = instance(db, time);
    await first.issue();

    expect(await first.attempt(CODE)).toMatchObject({ ok: true });
    time.advance(1000);

    expect(await first.attempt(CODE)).toEqual({
      ok: false,
      error: "code_used",
    });
    expect(await second.attempt(CODE)).toEqual({
      ok: false,
      error: "code_used",
    });
  });

  // #321-T03
  it("lets exactly one of several instances that submit the correct code at the same moment win", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    await instance(db, time).issue();
    const instances = Array.from({ length: 5 }, () => instance(db, time));

    const results = await Promise.all(
      instances.map((store) => store.attempt(CODE)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((entry) => !entry.ok))
      expect(["code_used", "rate_limited"]).toContain(result.error);
    const row = await db
      .selectFrom("setup_codes")
      .selectAll()
      .executeTakeFirst();
    expect(row?.used_at).not.toBeNull();
    // A correct code is not a wrong attempt, however many instances raced for it.
    expect(row?.failures).toBeLessThanOrEqual(results.length - 1);
  });
});

describe("expiry", () => {
  // #321-T03
  it("rejects the code from the 60th minute on, on every instance", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const issuing = instance(db, time);
    await issuing.issue();

    time.advance(SETUP_CODE_TTL_MS - 1);
    const lastMoment = await instance(db, time).attempt("000000");
    time.advance(1);

    expect(lastMoment).toEqual({ ok: false, error: "invalid_code" });
    expect(await instance(db, time).attempt(CODE)).toEqual({
      ok: false,
      error: "code_expired",
    });
    expect(await issuing.attempt(CODE)).toEqual({
      ok: false,
      error: "code_expired",
    });
  });

  // #321-T03
  it("reports the expiry time it stored when it issues the code", async () => {
    const { db } = await createTestDatabase();
    const time = clock();

    const issued = await instance(db, time).issue();

    expect(issued.expiresAt.getTime()).toBe(time.now() + SETUP_CODE_TTL_MS);
  });
});

describe("the attempt limit", () => {
  // #321-T02
  it("counts wrong attempts in the database: ten of them, spread over instances, lock every instance", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    await instance(db, time).issue();
    const instances = [instance(db, time), instance(db, time)];

    const results = [];
    for (let attempt = 0; attempt < SETUP_MAX_FAILURES; attempt += 1) {
      const store = instances[attempt % instances.length];
      results.push(await store?.attempt("000000"));
      time.advance(SETUP_ATTEMPT_WINDOW_MS);
    }

    expect(results.every((result) => result?.ok === false)).toBe(true);
    expect(
      results.every(
        (result) => result?.ok === false && result.error === "invalid_code",
      ),
    ).toBe(true);
    const row = await db
      .selectFrom("setup_codes")
      .selectAll()
      .executeTakeFirst();
    expect(row?.failures).toBe(SETUP_MAX_FAILURES);
    // The right code does not help any more, on any instance, even a fresh one.
    for (const store of [...instances, instance(db, time)])
      expect(await store.attempt(CODE)).toEqual({
        ok: false,
        error: "setup_locked",
      });
  });

  // #321-T02
  it("lets only the tenth wrong guess through to the comparison when several arrive at the same moment", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const store = instance(db, time);
    await store.issue();
    await wrongAttempts(store, time, SETUP_MAX_FAILURES - 1);

    const results = await Promise.all(
      Array.from({ length: SETUP_ATTEMPTS_PER_WINDOW }, () =>
        instance(db, time).attempt("000000"),
      ),
    );

    expect(
      results.filter((result) => !result.ok && result.error === "invalid_code"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.error === "setup_locked"),
    ).toHaveLength(SETUP_ATTEMPTS_PER_WINDOW - 1);
  });

  // #321-T02
  it("stays locked for an hour and more: only a new code unlocks", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const store = instance(db, time);
    await store.issue();
    await wrongAttempts(store, time, SETUP_MAX_FAILURES);

    time.advance(SETUP_CODE_TTL_MS / 2);
    expect(await store.attempt(CODE)).toEqual({
      ok: false,
      error: "setup_locked",
    });

    await store.issue();
    expect(await store.attempt(CODE)).toMatchObject({ ok: true });
  });

  // #321-T02
  it("allows five attempts per minute for the whole deployment, not per instance", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    await instance(db, time).issue();
    const instances = [instance(db, time), instance(db, time)];

    const results = [];
    for (
      let attempt = 0;
      attempt < SETUP_ATTEMPTS_PER_WINDOW + 1;
      attempt += 1
    ) {
      results.push(await instances[attempt % 2]?.attempt("000000"));
      time.advance(1000);
    }

    expect(results.slice(0, SETUP_ATTEMPTS_PER_WINDOW)).toEqual(
      Array.from({ length: SETUP_ATTEMPTS_PER_WINDOW }, () => ({
        ok: false,
        error: "invalid_code",
      })),
    );
    const limited = results[SETUP_ATTEMPTS_PER_WINDOW];
    expect(limited).toMatchObject({ ok: false, error: "rate_limited" });
    expect(
      limited?.ok === false ? limited.retryAfterSeconds : undefined,
    ).toBeGreaterThanOrEqual(1);
    // A refused attempt is not a wrong attempt.
    const row = await db
      .selectFrom("setup_codes")
      .selectAll()
      .executeTakeFirst();
    expect(row?.failures).toBe(SETUP_ATTEMPTS_PER_WINDOW);

    time.advance(SETUP_ATTEMPT_WINDOW_MS);
    expect(await instances[1]?.attempt(CODE)).toMatchObject({ ok: true });
  });

  // #321-T02
  it("keeps the count when the instance that counted is gone", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    await instance(db, time).issue();
    for (let attempt = 0; attempt < SETUP_ATTEMPTS_PER_WINDOW; attempt += 1)
      await instance(db, time).attempt("000000");

    expect(await instance(db, time).attempt(CODE)).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });
});

describe("what the database keeps", () => {
  // #321-T05
  it("holds a keyed hash of the code and nothing that contains it", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    await instance(db, time).issue();
    await instance(db, time).attempt("000000");

    const rows = await db.selectFrom("setup_codes").selectAll().execute();

    expect(JSON.stringify(rows)).not.toContain(CODE);
    expect(rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // #321-T05
  it("hashes with a key from the app secret: a stolen table cannot be checked without it, and another secret does not accept the code", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    await instance(db, time).issue();

    const foreign = instance(db, time, {
      secret: "another-secret-0123456789-0123456789-abcdefg",
    });

    expect(await foreign.attempt(CODE)).toEqual({
      ok: false,
      error: "invalid_code",
    });
  });

  // #321-T05
  it("hashes the same code differently for every issuance", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    await instance(db, time).issue();
    const first = await db
      .selectFrom("setup_codes")
      .select("code_hash")
      .executeTakeFirst();
    await instance(db, time).issue();
    const second = await db
      .selectFrom("setup_codes")
      .select("code_hash")
      .executeTakeFirst();

    expect(first?.code_hash).not.toBe(second?.code_hash);
  });

  // #321-T05
  it("never writes the code or a submitted value to a log", async () => {
    const { db } = await createTestDatabase();
    const time = clock();
    const lines: string[] = [];
    const store = createDatabaseSetupCodeStore({
      db,
      appSecret: SECRET,
      now: time.now,
      randomCode: () => CODE,
      log: (line) => lines.push(line),
    });
    await store.issue();
    await store.attempt("135790");
    await store.attempt(CODE);
    await store.invalidate();

    expect(lines.join("\n")).not.toMatch(/482913|135790/);
  });
});

describe("a database that cannot be read", () => {
  // #321-T03
  it("answers setup_unavailable, with one log line that names no value, when the table is missing", async () => {
    const { db } = await createTestDatabase();
    await db.schema.dropTable("setup_codes").execute();
    const lines: string[] = [];
    const store = createDatabaseSetupCodeStore({
      db,
      appSecret: SECRET,
      now: clock().now,
      log: (line) => lines.push(line),
    });

    expect(await store.attempt(CODE)).toEqual({
      ok: false,
      error: "setup_unavailable",
    });
    expect(await store.currentIssueId()).toBeNull();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("SETUP_CODE_STORE_UNAVAILABLE");
  });
});

const describePostgres = hasPostgres() ? describe : describe.skip;

describePostgres("the database backed setup code on Postgres", () => {
  // #321-T01
  it("is issued by one instance and accepted by another, each with a connection pool of its own", async () => {
    const postgres = await createPostgresTestDatabase();
    const time = clock();
    const issued = await instance(postgres.db, time).issue();

    const result = await instance(postgres.db, time).attempt(CODE);

    expect(result).toEqual({ ok: true, issueId: issued.issueId });
  });

  // #321-T03
  it("lets exactly one of twenty concurrent correct submissions win", async () => {
    const postgres = await createPostgresTestDatabase({ poolMax: 10 });
    const time = clock();
    await instance(postgres.db, time).issue();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        instance(postgres.db, time).attempt(CODE),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  // #321-T02
  it("lets only the tenth wrong guess through to the comparison when several arrive at the same moment", async () => {
    const postgres = await createPostgresTestDatabase({ poolMax: 10 });
    const time = clock();
    const store = instance(postgres.db, time);
    await store.issue();
    await wrongAttempts(store, time, SETUP_MAX_FAILURES - 1);

    const results = await Promise.all(
      Array.from({ length: SETUP_ATTEMPTS_PER_WINDOW }, () =>
        instance(postgres.db, time).attempt("000000"),
      ),
    );

    expect(
      results.filter((result) => !result.ok && result.error === "invalid_code"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.error === "setup_locked"),
    ).toHaveLength(SETUP_ATTEMPTS_PER_WINDOW - 1);
    const row = await postgres.db
      .selectFrom("setup_codes")
      .select("failures")
      .executeTakeFirst();
    expect(row?.failures).toBe(SETUP_MAX_FAILURES);
  });

  // #321-T02
  it("counts five attempts per minute across concurrent instances", async () => {
    const postgres = await createPostgresTestDatabase({ poolMax: 10 });
    const time = clock();
    await instance(postgres.db, time).issue();

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        instance(postgres.db, time).attempt("000000"),
      ),
    );

    expect(
      results.filter((result) => !result.ok && result.error === "invalid_code"),
    ).toHaveLength(SETUP_ATTEMPTS_PER_WINDOW);
    expect(
      results.filter((result) => !result.ok && result.error === "rate_limited"),
    ).toHaveLength(12 - SETUP_ATTEMPTS_PER_WINDOW);
  });
});

// The repository is what the store is built on; a test can read the rows through it too.
describe("the setup codes repository", () => {
  // #321-T01
  it("holds at most one row: replacing deletes the old one", async () => {
    const { db } = await createTestDatabase();
    const repository = createSetupCodesRepository(db);
    const createdAt = new Date("2026-10-15T08:00:00.000Z");

    await repository.replace({
      id: "a".repeat(32),
      codeHash: "0".repeat(64),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SETUP_CODE_TTL_MS),
    });
    await repository.replace({
      id: "b".repeat(32),
      codeHash: "1".repeat(64),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SETUP_CODE_TTL_MS),
    });

    expect((await repository.current())?.id).toBe("b".repeat(32));
    expect(
      await db.selectFrom("setup_codes").select("id").execute(),
    ).toHaveLength(1);
  });

  // #321-T01
  it("cannot hold a second row, however it is written", async () => {
    const { db } = await createTestDatabase();
    const repository = createSetupCodesRepository(db);
    const createdAt = new Date("2026-10-15T08:00:00.000Z");
    await repository.replace({
      id: "a".repeat(32),
      codeHash: "0".repeat(64),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SETUP_CODE_TTL_MS),
    });

    await expect(
      db
        .insertInto("setup_codes")
        .values({
          id: "c".repeat(32),
          slot: 1,
          code_hash: "2".repeat(64),
          created_at: createdAt.toISOString(),
          expires_at: createdAt.toISOString(),
          used_at: null,
          failures: 0,
          window_started_at: null,
          attempts_in_window: 0,
        })
        .execute(),
    ).rejects.toThrow();
  });

  // #321-T01
  it("keeps exactly one row, the last one written, when several replace it at the same moment", async () => {
    const { db } = await createTestDatabase();
    const repository = createSetupCodesRepository(db);
    const createdAt = new Date("2026-10-15T08:00:00.000Z");

    await Promise.all(
      "abcdef".split("").map((letter) =>
        repository.replace({
          id: letter.repeat(32),
          codeHash: letter.repeat(64),
          createdAt,
          expiresAt: new Date(createdAt.getTime() + SETUP_CODE_TTL_MS),
        }),
      ),
    );

    const rows = await db.selectFrom("setup_codes").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect((await repository.current())?.id).toBe(rows[0]?.id);
    expect(rows[0]?.code_hash).toBe((rows[0]?.id ?? "").slice(0, 1).repeat(64));
  });
});

describePostgres("the setup codes repository on Postgres", () => {
  // #321-T01
  it("keeps exactly one row, matching the issuance, when several replace it at the same moment on an empty table", async () => {
    const postgres = await createPostgresTestDatabase({ poolMax: 10 });
    const repository = createSetupCodesRepository(postgres.db);
    const createdAt = new Date("2026-10-15T08:00:00.000Z");

    await Promise.all(
      "abcdefghij".split("").map((letter) =>
        repository.replace({
          id: letter.repeat(32),
          codeHash: letter.repeat(64),
          createdAt,
          expiresAt: new Date(createdAt.getTime() + SETUP_CODE_TTL_MS),
        }),
      ),
    );

    const rows = await postgres.db
      .selectFrom("setup_codes")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code_hash).toBe((rows[0]?.id ?? "").slice(0, 1).repeat(64));
  });
});
