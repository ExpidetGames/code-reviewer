// SPDX-License-Identifier: Apache-2.0

// The balance journal repository (#495, ADR 0006, 2.7), on SQLite and on Postgres: entries are idempotent per key, the
// balance is the sum of the journal, a hold is taken by a conditional update and never overspends, and a reserve, a
// settlement and a refund racing on one workspace leave the cache equal to the sum. The cases that depend on the engine's
// locking run on both: Postgres with a pool and with two pools (two app instances), SQLite with one connection and with
// several processes on one file. Runs the Postgres half only when TEST_DATABASE_URL is set.
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { BillingJournalErrorCode } from "../../billing/journal.ts";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { startDbProcess } from "../../test-support/db-process.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addWorkspace } from "../../test-support/workspaces.ts";
import type { Database } from "../schema.ts";
import {
  createBillingJournalRepository,
  type BillingJournalRepository,
} from "./billing-journal-repository.ts";

const START = Date.parse("2026-10-19T08:00:00.000Z");
const USD = 1_000_000;

type Engine = {
  name: "sqlite" | "postgres";
  /** Postgres cases are skipped without TEST_DATABASE_URL. */
  skip: boolean;
  create: () => Promise<{
    db: Kysely<Database>;
    /** Where the database lives, for the cases that open it from another process or pool. */
    location: { path: string } | { url: string };
  }>;
};

const ENGINES: Engine[] = [
  {
    name: "sqlite",
    skip: false,
    async create() {
      const { db, config } = await createTestDatabase({
        busyTimeoutMs: 20_000,
      });
      return { db, location: { path: config.path } };
    },
  },
  {
    name: "postgres",
    skip: !hasPostgres(),
    async create() {
      const { db, url } = await createPostgresTestDatabase({ poolMax: 12 });
      return { db, location: { url } };
    },
  },
];

/** A clock that moves a millisecond per reading, so entries are ordered by when they were written. */
function steadyClock() {
  let at = START;
  return () => new Date((at += 1));
}

async function setup(engine: Engine) {
  const { db, location } = await engine.create();
  const workspaceId = await addWorkspace(db, "alpha");
  const otherWorkspaceId = await addWorkspace(db, "beta");
  const repoOf = (id: string, db2: Kysely<Database> = db) =>
    createBillingJournalRepository(db2, id, steadyClock());
  return {
    db,
    location,
    workspaceId,
    otherWorkspaceId,
    repo: repoOf(workspaceId),
    other: repoOf(otherWorkspaceId),
    repoOf,
  };
}

const topUp = (micro: number, key = `pi_${micro}`) => ({
  type: "top_up" as const,
  amountMicroUsd: micro,
  refKey: key,
  provider: "stripe",
  providerRef: key,
});

const charge = (ai: number, infra: number) => ({
  aiMicroUsd: ai,
  infraMicroUsd: infra,
  minutes: 3,
  reviewKind: "diff" as const,
});

async function sumOfEntries(db: Kysely<Database>, workspaceId: string) {
  const rows = await db
    .selectFrom("billing_journal_entries")
    .select(["amount_micro_usd"])
    .where("workspace_id", "=", workspaceId)
    .execute();
  return rows.reduce((total, row) => total + Number(row.amount_micro_usd), 0);
}

async function expectConsistent(repo: BillingJournalRepository) {
  expect(await repo.verify()).toMatchObject({
    differenceMicroUsd: 0,
    reservedDifferenceMicroUsd: 0,
    consistent: true,
  });
}

function codeOf(error: unknown): BillingJournalErrorCode | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error.code as BillingJournalErrorCode)
    : undefined;
}

async function thrownCode(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return codeOf(error);
  }
  return undefined;
}

/**
 * Waits until another connection is blocked on a lock, so a staged race is not decided by a timer. SQLite has one
 * connection per database: the second transaction waits for the connection, a short pause lets it queue.
 */
async function untilBlocked(engine: Engine, db: Kysely<Database>) {
  if (engine.name === "sqlite") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return;
  }
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { rows } = await sql<{
      n: string;
    }>`select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
      db,
    );
    if (Number(rows[0]?.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No connection ever blocked on a lock.");
}

/** The seeded generator of T11: the same numbers on every run. */
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const engine of ENGINES) {
  describe.skipIf(engine.skip)(`the balance journal on ${engine.name}`, () => {
    // #495-T01
    it("makes the balance the sum of a top-up, a reservation, and a usage with its release, and the reserved amount 0 after the release", async () => {
      const { db, workspaceId, repo } = await setup(engine);

      await repo.append(topUp(10 * USD));
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 10 * USD,
        reservedMicroUsd: 0,
      });
      const reserved = await repo.reserve(3 * USD, "job-1");
      expect(reserved).toMatchObject({ ok: true, created: true });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 7 * USD,
        reservedMicroUsd: 3 * USD,
      });
      const settled = await repo.settle("job-1", charge(500_000, 1_000_000));

      expect(settled).toMatchObject({
        ok: true,
        created: true,
        release: { type: "release", amountMicroUsd: 3 * USD, jobId: "job-1" },
        usage: {
          type: "usage",
          amountMicroUsd: -1_500_000,
          aiMicroUsd: 500_000,
          infraMicroUsd: 1_000_000,
          minutes: 3,
          reviewKind: "diff",
        },
      });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 10 * USD - 1_500_000,
        reservedMicroUsd: 0,
      });
      expect(await sumOfEntries(db, workspaceId)).toBe(10 * USD - 1_500_000);
      await expectConsistent(repo);
    });

    // #495-T01
    it("refuses to append a reservation, a release or a usage (only reserve, release and settle write them)", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");
      const before = await repo.balance();

      const refused = [
        { type: "reservation", amountMicroUsd: -USD, jobId: "job-2" },
        { type: "release", amountMicroUsd: 2 * USD, jobId: "job-1" },
        {
          type: "usage",
          amountMicroUsd: -USD,
          jobId: "job-1",
          aiMicroUsd: 0,
          infraMicroUsd: USD,
          minutes: 2,
          reviewKind: "dynamic",
        },
      ] as const;
      expect(
        await Promise.all(
          refused.map((entry) => thrownCode(() => repo.append(entry))),
        ),
      ).toEqual([
        "reservation_required",
        "job_entry_required",
        "job_entry_required",
      ]);

      expect(await repo.balance()).toEqual(before);
      expect((await repo.entries({ limit: 10 })).entries).toHaveLength(2);
      // The two ways to write them are still there.
      expect(await repo.settle("job-1", charge(0, USD))).toMatchObject({
        ok: true,
      });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 9 * USD,
        reservedMicroUsd: 0,
      });
      await expectConsistent(repo);
    });

    // #495-T02
    it("returns the existing entry for the same key and changes the balance once", async () => {
      const { db, workspaceId, repo } = await setup(engine);

      const first = await repo.append(topUp(5 * USD, "pi_same"));
      const second = await repo.append(topUp(5 * USD, "pi_same"));

      expect(first.created).toBe(true);
      expect(second).toEqual({ entry: first.entry, created: false });
      expect((await repo.balance()).balanceMicroUsd).toBe(5 * USD);
      expect(
        await db
          .selectFrom("billing_journal_entries")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .execute(),
      ).toHaveLength(1);
    });

    // #495-T02
    it("repeats a reserve, a settlement and a release of one job without a second charge", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(10 * USD));

      const reserve1 = await repo.reserve(2 * USD, "job-1");
      const reserve2 = await repo.reserve(2 * USD, "job-1");
      const settle1 = await repo.settle("job-1", charge(0, USD));
      const settle2 = await repo.settle("job-1", charge(0, USD));
      const release = await repo.release("job-1");

      expect(reserve1).toMatchObject({ ok: true, created: true });
      expect(reserve2).toMatchObject({ ok: true, created: false });
      expect(settle1).toMatchObject({ ok: true, created: true });
      expect(settle2).toMatchObject({ ok: true, created: false });
      expect(release).toMatchObject({ ok: true, created: false });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 9 * USD,
        reservedMicroUsd: 0,
      });
      expect(
        (
          await db
            .selectFrom("billing_journal_entries")
            .select("type")
            .where("workspace_id", "=", workspaceId)
            .execute()
        )
          .map((row) => row.type)
          .sort(),
      ).toEqual(["release", "reservation", "top_up", "usage"]);
      await expectConsistent(repo);
    });

    // #495-T02
    it("answers a repeated reserve with the reservation it holds even when the balance has since run out", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(3 * USD));
      await repo.reserve(3 * USD, "job-1");

      const again = await repo.reserve(3 * USD, "job-1");

      expect(again).toMatchObject({ ok: true, created: false });
      expect((await repo.balance()).balanceMicroUsd).toBe(0);
    });

    // #495-T03
    it("refuses the same key with another amount with a stable code and changes nothing", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(5 * USD, "pi_same"));
      await repo.reserve(USD, "job-1");
      const before = await repo.balance();
      const entriesBefore = await sumOfEntries(db, workspaceId);

      for (const attempt of [
        () => repo.append({ ...topUp(6 * USD, "pi_same") }),
        () => repo.reserve(2 * USD, "job-1"),
      ])
        expect(await thrownCode(attempt)).toBe("idempotency_conflict");

      expect(await repo.balance()).toEqual(before);
      expect(await sumOfEntries(db, workspaceId)).toBe(entriesBefore);
    });

    // #495-T03
    it("refuses a settlement repeated with another charge, and a charge of zero after a usage", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");
      await repo.settle("job-1", charge(0, USD));
      const before = await repo.balance();

      expect(
        await thrownCode(() => repo.settle("job-1", charge(0, 2 * USD))),
      ).toBe("idempotency_conflict");
      expect(await thrownCode(() => repo.settle("job-1", charge(0, 0)))).toBe(
        "idempotency_conflict",
      );
      expect(await repo.balance()).toEqual(before);
    });

    // #495-T07
    it("refuses an entry that breaks a rule with the code invalid_entry before any statement", async () => {
      const { repo } = await setup(engine);

      for (const entry of [
        { ...topUp(USD), amountMicroUsd: -USD },
        { type: "refund" as const, amountMicroUsd: USD, refKey: "re_1" },
        {
          type: "correction" as const,
          amountMicroUsd: -300,
          refKey: "fix-1",
          aiMicroUsd: 1,
          infraMicroUsd: 1,
        },
      ])
        expect(await thrownCode(() => repo.append(entry))).toBe(
          "invalid_entry",
        );
      expect(await thrownCode(() => repo.reserve(0, "job-1"))).toBe(
        "invalid_entry",
      );
      expect(await thrownCode(() => repo.reserve(1.5, "job-1"))).toBe(
        "invalid_entry",
      );
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: 0,
      });
    });

    // #495-T05
    it("lets 20 parallel reserves of 3 against a balance of 10 succeed exactly 3 times", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(10 * USD));

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          repo.reserve(3 * USD, `job-${index}`),
        ),
      );

      expect(results.filter((result) => result.ok)).toHaveLength(3);
      expect(results.filter((result) => !result.ok)).toEqual(
        Array.from({ length: 17 }, () => ({
          ok: false,
          code: "insufficient_balance",
          balanceMicroUsd: expect.any(Number),
        })),
      );
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: USD,
        reservedMicroUsd: 9 * USD,
      });
      expect(await sumOfEntries(db, workspaceId)).toBe(USD);
      await expectConsistent(repo);
    });

    // #495-T05
    it("leaves no entry of a refused reserve", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(USD));

      const refused = await repo.reserve(2 * USD, "job-1");

      expect(refused).toEqual({
        ok: false,
        code: "insufficient_balance",
        balanceMicroUsd: USD,
      });
      expect(
        (
          await db
            .selectFrom("billing_journal_entries")
            .select("type")
            .where("workspace_id", "=", workspaceId)
            .execute()
        ).map((row) => row.type),
      ).toEqual(["top_up"]);
    });

    // #495-T05
    it("refuses a reserve of a workspace that has no balance row, and creates none", async () => {
      const { db, workspaceId, repo } = await setup(engine);

      const refused = await repo.reserve(USD, "job-1");

      expect(refused).toEqual({
        ok: false,
        code: "insufficient_balance",
        balanceMicroUsd: 0,
      });
      expect(
        await db
          .selectFrom("billing_balances")
          .select("workspace_id")
          .where("workspace_id", "=", workspaceId)
          .execute(),
      ).toEqual([]);
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: 0,
      });
    });

    // #495-T06
    it("keeps the cache equal to the sum when a reserve, a settlement, a refund and a top-up race on one workspace", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(20 * USD));
      for (let round = 0; round < 8; round += 1) {
        await repo.reserve(2 * USD, `held-${round}`);
        await Promise.all([
          repo.reserve(3 * USD, `new-${round}`),
          repo.settle(`held-${round}`, charge(100_000, 400_000)),
          repo.append({
            type: "refund",
            amountMicroUsd: -USD,
            refKey: `re_${round}`,
          }),
          repo.append(topUp(2 * USD, `pi_race_${round}`)),
          repo.release(`new-${round}`),
        ]);
        await expectConsistent(repo);
      }

      const { balanceMicroUsd } = await repo.balance();
      expect(balanceMicroUsd).toBe(await sumOfEntries(db, workspaceId));
      await expectConsistent(repo);
    });

    // #495-T06
    it("settles one job once when the settlement is retried at the same moment", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");

      const results = await Promise.all(
        Array.from({ length: 6 }, () => repo.settle("job-1", charge(0, USD))),
      );

      expect(
        results.filter((result) => result.ok && result.created),
      ).toHaveLength(1);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 9 * USD,
        reservedMicroUsd: 0,
      });
      expect(await sumOfEntries(db, workspaceId)).toBe(9 * USD);
    });

    // #495-T06
    it("reserves one job once when the same claim is repeated at the same moment", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));

      const results = await Promise.all(
        Array.from({ length: 6 }, () => repo.reserve(2 * USD, "job-1")),
      );

      expect(
        results.filter((result) => result.ok && result.created),
      ).toHaveLength(1);
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 8 * USD,
        reservedMicroUsd: 2 * USD,
      });
    });

    // #495-T08
    it("accepts a refund larger than the balance, takes the balance below zero, and refuses a reserve of any amount", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(5 * USD));

      const refund = await repo.append({
        type: "refund",
        amountMicroUsd: -8 * USD,
        refKey: "re_1",
        provider: "stripe",
        providerRef: "re_1",
      });

      expect(refund.created).toBe(true);
      expect((await repo.balance()).balanceMicroUsd).toBe(-3 * USD);
      const entriesBefore = await sumOfEntries(db, workspaceId);
      for (const hold of [1, USD, 100 * USD])
        expect(await repo.reserve(hold, `job-${hold}`)).toEqual({
          ok: false,
          code: "balance_negative",
          balanceMicroUsd: -3 * USD,
        });
      expect(await sumOfEntries(db, workspaceId)).toBe(entriesBefore);
      // Credit lifts the block again.
      await repo.append(topUp(10 * USD, "pi_back"));
      expect(await repo.reserve(USD, "job-after")).toMatchObject({ ok: true });
      await expectConsistent(repo);
    });

    // #495-T08
    it("lets a chargeback and a final charge take the balance below zero as well", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(2 * USD));
      await repo.reserve(2 * USD, "job-1");

      // The charge is more than the hold: the final charge may take the balance slightly negative.
      await repo.settle("job-1", charge(500_000, 2 * USD));
      expect((await repo.balance()).balanceMicroUsd).toBe(-500_000);
      expect(await repo.reserve(1, "job-2")).toMatchObject({
        ok: false,
        code: "balance_negative",
      });
      await repo.append({
        type: "chargeback",
        amountMicroUsd: -USD,
        refKey: "dp_1",
      });
      expect((await repo.balance()).balanceMicroUsd).toBe(-1_500_000);
      await expectConsistent(repo);
    });

    // #495-T09
    it("accepts a correction that reverses an entry once and refuses the second", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      const refund = await repo.append({
        type: "refund",
        amountMicroUsd: -4 * USD,
        refKey: "re_1",
      });

      const reversal = await repo.append({
        type: "correction",
        amountMicroUsd: 4 * USD,
        refKey: "reverse-re_1",
        reversesEntryId: refund.entry.id,
      });
      const again = await thrownCode(() =>
        repo.append({
          type: "correction",
          amountMicroUsd: 4 * USD,
          refKey: "reverse-re_1-again",
          reversesEntryId: refund.entry.id,
        }),
      );

      expect(reversal.entry.reversesEntryId).toBe(refund.entry.id);
      expect(again).toBe("already_reversed");
      expect((await repo.balance()).balanceMicroUsd).toBe(10 * USD);
      await expectConsistent(repo);
    });

    // #495-T09
    it("refuses a reversal of an entry that is not there, of the wrong amount, or of a hold", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      const refund = await repo.append({
        type: "refund",
        amountMicroUsd: -USD,
        refKey: "re_1",
      });
      const reserved = await repo.reserve(USD, "job-1");
      if (!reserved.ok) throw new Error("seeding failed");

      expect(
        await thrownCode(() =>
          repo.append({
            type: "correction",
            amountMicroUsd: USD,
            refKey: "c-1",
            reversesEntryId: "nothing",
          }),
        ),
      ).toBe("reversed_entry_not_found");
      expect(
        await thrownCode(() =>
          repo.append({
            type: "correction",
            amountMicroUsd: 2 * USD,
            refKey: "c-2",
            reversesEntryId: refund.entry.id,
          }),
        ),
      ).toBe("invalid_entry");
      expect(
        await thrownCode(() =>
          repo.append({
            type: "correction",
            amountMicroUsd: USD,
            refKey: "c-3",
            reversesEntryId: reserved.entry.id,
          }),
        ),
      ).toBe("invalid_entry");
      expect((await repo.balance()).balanceMicroUsd).toBe(8 * USD);
    });

    // #495-T09
    it("lets two reversals of one entry race and lets one win", async () => {
      const { repo } = await setup(engine);
      const refund = await repo.append({
        type: "refund",
        amountMicroUsd: -USD,
        refKey: "re_1",
      });

      const outcomes = await Promise.all(
        [1, 2, 3, 4].map((index) =>
          repo
            .append({
              type: "correction",
              amountMicroUsd: USD,
              refKey: `reverse-${index}`,
              reversesEntryId: refund.entry.id,
            })
            .then(() => "done" as const)
            .catch((error: unknown) => codeOf(error)),
        ),
      );

      expect(outcomes.filter((outcome) => outcome === "done")).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome === "already_reversed"),
      ).toHaveLength(3);
      expect((await repo.balance()).balanceMicroUsd).toBe(0);
      await expectConsistent(repo);
    });

    // #495-T10
    it("pages 120 entries newest first with a cursor, complete, ordered and without a duplicate", async () => {
      const { db, workspaceId, otherWorkspaceId } = await setup(engine);
      // A clock that stays on one millisecond for five entries at a time: the sequence number breaks the tie.
      let readings = 0;
      const repo = createBillingJournalRepository(
        db,
        workspaceId,
        () => new Date(START + Math.floor((readings += 1) / 5)),
      );
      const written: string[] = [];
      for (let index = 0; index < 120; index += 1)
        written.push(
          (await repo.append(topUp(USD + index, `pi_page_${index}`))).entry.id,
        );
      await createBillingJournalRepository(db, otherWorkspaceId).append(
        topUp(USD, "pi_elsewhere"),
      );

      const seen: string[] = [];
      let cursor: Awaited<ReturnType<typeof repo.entries>>["next"];
      let pages = 0;
      do {
        const page = await repo.entries({ cursor, limit: 25 });
        pages += 1;
        expect(page.entries.length).toBeLessThanOrEqual(25);
        seen.push(...page.entries.map((entry) => entry.id));
        cursor = page.next;
      } while (cursor !== undefined);

      expect(pages).toBe(5);
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
      expect([...seen].sort()).toEqual([...written].sort());
      const all = await repo.entries({ limit: 200 });
      expect(all.next).toBeUndefined();
      expect(all.entries.map((entry) => entry.id)).toEqual(seen);
      const times = all.entries.map((entry) => entry.createdAt);
      expect(times).toEqual([...times].sort().reverse());
    });

    // #495-T10
    it("answers an empty journal with an empty page and no cursor", async () => {
      const { repo } = await setup(engine);

      expect(await repo.entries({ limit: 10 })).toEqual({
        entries: [],
        next: undefined,
      });
    });

    // #495-T11
    it.each([1, 7, 2026])(
      "keeps the cache equal to the journal through a random sequence (seed %i)",
      async (seed) => {
        const { db, workspaceId, repo } = await setup(engine);
        const random = mulberry32(seed);
        const open: string[] = [];
        let jobs = 0;
        let references = 0;

        for (let step = 0; step < 60; step += 1) {
          const pick = random();
          if (pick < 0.2) {
            references += 1;
            await repo.append(
              topUp(Math.ceil(random() * 10 * USD), `pi_${references}`),
            );
          } else if (pick < 0.5) {
            jobs += 1;
            const result = await repo.reserve(
              Math.ceil(random() * 4 * USD),
              `job-${jobs}`,
            );
            if (result.ok) open.push(`job-${jobs}`);
          } else if (pick < 0.7 && open.length > 0) {
            const job = open.splice(Math.floor(random() * open.length), 1)[0];
            await repo.settle(
              job ?? "",
              charge(
                Math.floor(random() * USD),
                Math.floor(random() * 3 * USD),
              ),
            );
          } else if (pick < 0.8 && open.length > 0) {
            const job = open.splice(Math.floor(random() * open.length), 1)[0];
            await repo.release(job ?? "");
          } else if (pick < 0.9) {
            references += 1;
            await repo.append({
              type: random() < 0.5 ? "refund" : "chargeback",
              amountMicroUsd: -Math.ceil(random() * 6 * USD),
              refKey: `ref_${references}`,
            });
          } else {
            references += 1;
            await repo.append({
              type: "correction",
              amountMicroUsd:
                (random() < 0.5 ? 1 : -1) * Math.ceil(random() * USD),
              refKey: `fix_${references}`,
            });
          }
          if (step % 10 === 9) await expectConsistent(repo);
        }

        expect((await repo.balance()).balanceMicroUsd).toBe(
          await sumOfEntries(db, workspaceId),
        );
        await expectConsistent(repo);
      },
    );

    // #495-T11
    it("reports the difference of a cache row that was broken by hand", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");
      await expectConsistent(repo);

      await db
        .updateTable("billing_balances")
        .set({
          balance_micro_usd: 8 * USD + 7,
          reserved_micro_usd: 2 * USD - 3,
        })
        .where("workspace_id", "=", workspaceId)
        .execute();
      const broken = await repo.verify();

      expect(broken).toEqual({
        balanceMicroUsd: 8 * USD + 7,
        expectedBalanceMicroUsd: 8 * USD,
        differenceMicroUsd: 7,
        reservedMicroUsd: 2 * USD - 3,
        expectedReservedMicroUsd: 2 * USD,
        reservedDifferenceMicroUsd: -3,
        strandedHoldCount: 0,
        strandedHoldMicroUsd: 0,
        consistent: false,
      });
    });

    // #495-T11
    it("verifies a workspace without entries and a missing cache row of a workspace with entries", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      expect(await repo.verify()).toMatchObject({ consistent: true });

      await repo.append(topUp(USD));
      await db
        .deleteFrom("billing_balances")
        .where("workspace_id", "=", workspaceId)
        .execute();

      expect(await repo.verify()).toMatchObject({
        balanceMicroUsd: 0,
        expectedBalanceMicroUsd: USD,
        differenceMicroUsd: -USD,
        consistent: false,
      });
    });

    // #495-T12
    it("keeps the entries, the balance and the keys of two workspaces apart", async () => {
      const { repo, other, workspaceId, otherWorkspaceId } =
        await setup(engine);
      await repo.append(topUp(5 * USD, "pi_shared"));
      await other.append(topUp(7 * USD, "pi_shared"));
      await repo.reserve(USD, "job-1");

      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 4 * USD,
        reservedMicroUsd: USD,
      });
      expect(await other.balance()).toEqual({
        balanceMicroUsd: 7 * USD,
        reservedMicroUsd: 0,
      });
      expect(
        (await repo.entries({ limit: 50 })).entries.map(
          (entry) => entry.workspaceId,
        ),
      ).toEqual([workspaceId, workspaceId]);
      expect(
        (await other.entries({ limit: 50 })).entries.map(
          (entry) => entry.workspaceId,
        ),
      ).toEqual([otherWorkspaceId]);
      // The key is per workspace; B cannot settle, release or reverse what is A's.
      expect(await other.settle("job-1", charge(0, USD))).toEqual({
        ok: false,
        code: "reservation_not_found",
      });
      expect(await other.release("job-1")).toEqual({
        ok: false,
        code: "reservation_not_found",
      });
      const aEntry = (await repo.entries({ limit: 1 })).entries[0];
      expect(
        await thrownCode(() =>
          other.append({
            type: "correction",
            amountMicroUsd: USD,
            refKey: "steal",
            reversesEntryId: aEntry?.id,
          }),
        ),
      ).toBe("reversed_entry_not_found");
      await expectConsistent(repo);
      await expectConsistent(other);
    });

    // #495-T12
    it("keeps a workspace's reserves from spending another's balance", async () => {
      const { repo, other } = await setup(engine);
      await other.append(topUp(100 * USD));

      expect(await repo.reserve(USD, "job-1")).toMatchObject({
        ok: false,
        code: "insufficient_balance",
      });
    });

    // The settlement and the release in their edge cases.
    // #495-T02
    it("answers a settlement or a release without a reservation with a code and writes nothing", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(USD));

      expect(await repo.settle("job-x", charge(0, 1))).toEqual({
        ok: false,
        code: "reservation_not_found",
      });
      expect(await repo.release("job-x")).toEqual({
        ok: false,
        code: "reservation_not_found",
      });

      expect(await sumOfEntries(db, workspaceId)).toBe(USD);
      expect((await repo.entries({ limit: 10 })).entries).toHaveLength(1);
    });

    // #495-T02
    it("releases the hold of a job that never ran and refuses to bill it afterwards", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");

      const released = await repo.release("job-1");
      const settled = await repo.settle("job-1", charge(0, USD));

      expect(released).toMatchObject({ ok: true, created: true });
      expect(settled).toEqual({ ok: false, code: "job_already_released" });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 10 * USD,
        reservedMicroUsd: 0,
      });
    });

    // #495-T02
    it("settles a job that cost nothing with a release and no usage entry", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");

      const settled = await repo.settle("job-1", charge(0, 0));

      expect(settled).toMatchObject({ ok: true, usage: null, created: true });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 10 * USD,
        reservedMicroUsd: 0,
      });
      await expectConsistent(repo);
    });

    // #495-T07
    it("refuses a settlement with a part that is not an integer", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");

      expect(
        await thrownCode(() => repo.settle("job-1", charge(0.5, USD))),
      ).toBe("invalid_entry");
      expect(
        await thrownCode(() => repo.settle("job-1", charge(-1, USD))),
      ).toBe("invalid_entry");
      expect((await repo.balance()).reservedMicroUsd).toBe(2 * USD);
    });

    // #495-T05
    it("keeps an amount above 32 bits exact (a balance past USD 2,147)", async () => {
      const { repo } = await setup(engine);

      await repo.append(topUp(500 * USD, "pi_1"));
      await repo.append(topUp(500 * USD, "pi_2"));
      await repo.append(topUp(500 * USD, "pi_3"));
      await repo.append(topUp(500 * USD, "pi_4"));
      await repo.append(topUp(500 * USD, "pi_5"));

      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 2500 * USD,
        reservedMicroUsd: 0,
      });
      expect(await repo.reserve(2400 * USD, "job-1")).toMatchObject({
        ok: true,
      });
      expect(
        (await repo.entries({ limit: 1 })).entries[0]?.amountMicroUsd,
      ).toBe(-2400 * USD);
      await expectConsistent(repo);
    });

    // The release and the settlement of one job decide under one lock.
    // #495-T06
    it("refuses to charge a job whose release commits first, even when the settlement started before the commit", async () => {
      const { db, workspaceId, repo, repoOf } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");

      let settlement:
        Promise<Awaited<ReturnType<typeof repo.settle>>> | undefined;
      await db.transaction().execute(async (trx) => {
        expect(await repoOf(workspaceId, trx).release("job-1")).toMatchObject({
          ok: true,
          created: true,
        });
        // The settlement starts while the release is not committed yet, and has to wait for it.
        settlement = repo.settle("job-1", charge(USD, USD));
        await untilBlocked(engine, db);
      });

      expect(await settlement).toEqual({
        ok: false,
        code: "job_already_released",
      });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 10 * USD,
        reservedMicroUsd: 0,
      });
      // Only the top-up, the hold and the release: no usage.
      expect(
        (await repo.entries({ limit: 10 })).entries.map((e) => e.type).sort(),
      ).toEqual(["release", "reservation", "top_up"]);
      await expectConsistent(repo);
    });

    // Every write takes the balance row first (settle, release, reserve, append), so no two of them can wait for each other.
    // #495-T06
    it.skipIf(engine.name !== "postgres")(
      "takes the balance row's lock before an append writes, so it cannot deadlock with a writer that holds the lock",
      async () => {
        const { db, workspaceId, repo, repoOf } = await setup(engine);
        await repo.append(topUp(10 * USD));
        let appended: Promise<unknown> = Promise.resolve();
        let outcome: unknown;
        await db.transaction().execute(async (trx) => {
          // This transaction holds the balance row, as a settlement does.
          await sql`select 1 from billing_balances where workspace_id = ${workspaceId} for update`.execute(
            trx,
          );
          appended = repo.append(topUp(USD, "pi_race")).then(
            (value) => value,
            (error: unknown) => error,
          );
          await untilBlocked(engine, db);
          // The same key from the lock holder. If the append had written its row before it waited for the lock, this
          // insert would wait for it and the two would wait for each other: Postgres ends one with a deadlock error.
          outcome = await repoOf(workspaceId, trx).append(
            topUp(USD, "pi_race"),
          );
        });

        expect(outcome).toMatchObject({ created: true });
        expect(await appended).toMatchObject({ created: false });
        expect((await repo.balance()).balanceMicroUsd).toBe(11 * USD);
        await expectConsistent(repo);
      },
    );

    // #495-T06
    it("lets top-ups, refunds and corrections race with settlements and releases of one workspace without an error", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(100 * USD));
      const jobs = Array.from({ length: 16 }, (_, index) => `job-${index}`);
      for (const jobId of jobs) await repo.reserve(USD, jobId);

      const results = await Promise.allSettled(
        jobs.flatMap((jobId, index) => [
          index % 4 === 0
            ? repo.release(jobId)
            : repo.settle(jobId, charge(0, 500_000)),
          repo.append(topUp(USD, `pi_race_${index}`)),
          index % 2 === 0
            ? repo.append({
                type: "refund",
                amountMicroUsd: -250_000,
                refKey: `re_race_${index}`,
              })
            : repo.append({
                type: "correction",
                amountMicroUsd: 125_000,
                refKey: `fix_race_${index}`,
              }),
        ]),
      );

      expect(results.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
      // 100 + 16 top-ups - 8 refunds of 0.25 + 8 corrections of 0.125 - 12 charges of 0.5.
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 100 * USD + 16 * USD - 2 * USD + USD - 6 * USD,
        reservedMicroUsd: 0,
      });
      await expectConsistent(repo);
    });

    // reserveUpTo: the hold of a claim (#498), capped by the balance under the same lock as reserve.
    // #495-T05
    it("holds the wanted amount when the balance covers it and the whole balance when it does not", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));

      const full = await repo.reserveUpTo("job-1", 3 * USD);
      const partial = await repo.reserveUpTo("job-2", 20 * USD);

      expect(full).toMatchObject({ ok: true, created: true });
      expect(full.ok && full.entry.amountMicroUsd).toBe(-3 * USD);
      expect(partial).toMatchObject({ ok: true, created: true });
      expect(partial.ok && partial.entry.amountMicroUsd).toBe(-7 * USD);
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: 10 * USD,
      });
      await expectConsistent(repo);
    });

    // #495-T02
    it("answers a retried claim with the reservation it holds, whatever the balance and the wanted amount are now", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(5 * USD, "pi_first"));
      const first = await repo.reserve(5 * USD, "job-1");
      await repo.append(topUp(2 * USD, "pi_second"));

      const retry = await repo.reserveUpTo("job-1", 2 * USD);
      const bigger = await repo.reserveUpTo("job-1", 50 * USD);

      expect(first.ok && first.entry.amountMicroUsd).toBe(-5 * USD);
      for (const again of [retry, bigger]) {
        expect(again).toMatchObject({ ok: true, created: false });
        expect(again.ok && again.entry).toEqual(first.ok && first.entry);
      }
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 2 * USD,
        reservedMicroUsd: 5 * USD,
      });
      await expectConsistent(repo);
    });

    // #495-T02
    it("answers a retried claim with its reservation even when a refund has taken the balance below zero", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(5 * USD));
      await repo.reserveUpTo("job-1", 5 * USD);
      await repo.append({
        type: "refund",
        amountMicroUsd: -3 * USD,
        refKey: "re_1",
      });

      const retry = await repo.reserveUpTo("job-1", 5 * USD);

      expect(retry).toMatchObject({ ok: true, created: false });
      expect((await repo.balance()).balanceMicroUsd).toBe(-3 * USD);
    });

    // #495-T08
    it("refuses a claim with balance_exhausted at a balance of zero and balance_negative below it, and writes nothing", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      // No balance row at all: nothing was ever credited.
      expect(await repo.reserveUpTo("job-0", USD)).toEqual({
        ok: false,
        code: "balance_exhausted",
        balanceMicroUsd: 0,
      });
      await repo.append(topUp(2 * USD));
      await repo.reserveUpTo("job-1", 5 * USD); // takes all of it: the balance is 0
      expect(await repo.reserveUpTo("job-2", USD)).toEqual({
        ok: false,
        code: "balance_exhausted",
        balanceMicroUsd: 0,
      });
      await repo.append({
        type: "refund",
        amountMicroUsd: -USD,
        refKey: "re_1",
      });
      expect(await repo.reserveUpTo("job-3", USD)).toEqual({
        ok: false,
        code: "balance_negative",
        balanceMicroUsd: -USD,
      });

      expect(
        (
          await db
            .selectFrom("billing_journal_entries")
            .select("ref_key")
            .where("workspace_id", "=", workspaceId)
            .where("type", "=", "reservation")
            .execute()
        ).map((row) => row.ref_key),
      ).toEqual(["job-1"]);
      await expectConsistent(repo);
    });

    // A requeued job keeps its hold; only a job that ends free gives it back (src/billing/README.md, for #498).
    // #495-T02
    it("answers a claim of a job whose hold was released with reservation_released, and holds nothing", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserveUpTo("job-1", 3 * USD);
      await repo.release("job-1"); // the job ended free
      await repo.reserveUpTo("job-2", 3 * USD);
      await repo.settle("job-2", charge(0, USD)); // the job was charged
      const before = await repo.balance();
      const entriesBefore = (await repo.entries({ limit: 50 })).entries.length;

      for (const jobId of ["job-1", "job-2"]) {
        expect(await repo.reserveUpTo(jobId, 3 * USD)).toEqual({
          ok: false,
          code: "reservation_released",
          balanceMicroUsd: before.balanceMicroUsd,
        });
        expect(await repo.reserve(3 * USD, jobId)).toEqual({
          ok: false,
          code: "reservation_released",
          balanceMicroUsd: before.balanceMicroUsd,
        });
      }

      expect(await repo.balance()).toEqual(before);
      expect((await repo.entries({ limit: 50 })).entries).toHaveLength(
        entriesBefore,
      );
      await expectConsistent(repo);
    });

    // #495-T02
    it("lets a job that is claimed again before it ended settle with the hold of its first claim", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      const first = await repo.reserveUpTo("job-1", 3 * USD);
      const requeued = await repo.reserveUpTo("job-1", 3 * USD);

      expect(requeued).toMatchObject({ ok: true, created: false });
      expect(requeued.ok && requeued.entry).toEqual(first.ok && first.entry);
      expect(await repo.settle("job-1", charge(0, USD))).toMatchObject({
        ok: true,
        created: true,
      });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 9 * USD,
        reservedMicroUsd: 0,
      });
      await expectConsistent(repo);
    });

    // #495-T07
    it("refuses a claim without a job or with an amount that is not a positive integer", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(USD));

      for (const attempt of [
        () => repo.reserveUpTo("", USD),
        () => repo.reserveUpTo("job-1", 0),
        () => repo.reserveUpTo("job-1", -1),
        () => repo.reserveUpTo("job-1", 1.5),
      ])
        expect(await thrownCode(attempt)).toBe("invalid_entry");
      expect((await repo.balance()).reservedMicroUsd).toBe(0);
    });

    // #495-T05
    it("lets 20 parallel claims of up to 3 against a balance of 10 hold exactly the balance", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(10 * USD));

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          repo.reserveUpTo(`job-${index}`, 3 * USD),
        ),
      );

      const held = results.flatMap((result) =>
        result.ok ? [-result.entry.amountMicroUsd] : [],
      );
      expect(held.sort((a, b) => a - b)).toEqual([
        USD,
        3 * USD,
        3 * USD,
        3 * USD,
      ]);
      expect(
        results.filter(
          (result) => !result.ok && result.code === "balance_exhausted",
        ),
      ).toHaveLength(16);
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: 10 * USD,
      });
      expect(await sumOfEntries(db, workspaceId)).toBe(0);
      await expectConsistent(repo);
    });

    // #495-T06
    it("holds one job once when the same claim is repeated at the same moment", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));

      const results = await Promise.all(
        Array.from({ length: 6 }, () => repo.reserveUpTo("job-1", 4 * USD)),
      );

      expect(
        results.filter((result) => result.ok && result.created),
      ).toHaveLength(1);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 6 * USD,
        reservedMicroUsd: 4 * USD,
      });
    });

    // verify reads the sum and the cache as one snapshot.
    // #495-T11
    it("reads the sum and the cache in one statement", async () => {
      const { db, workspaceId, repo } = await setup(engine);
      await repo.append(topUp(5 * USD));
      let statements = 0;
      const counting = db.withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          statements += 1;
          return result;
        },
      });

      const verified = await createBillingJournalRepository(
        counting,
        workspaceId,
      ).verify();

      expect(verified).toMatchObject({ consistent: true });
      expect(statements).toBe(1);
    });

    // #495-T11
    it("reports no drift while other callers write", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(100 * USD));
      let writing = true;
      const writers = [0, 1].map(async (writer) => {
        for (let index = 0; writing; index += 1) {
          await repo.append(topUp(USD, `pi_busy_${writer}_${index}`));
          await repo.reserve(USD, `busy_${writer}_${index}`);
          await repo.settle(`busy_${writer}_${index}`, charge(1, 1));
        }
      });

      const drifting = [];
      for (let round = 0; round < 60; round += 1) {
        const verified = await repo.verify();
        if (!verified.consistent) drifting.push(verified);
      }
      writing = false;
      await Promise.all(writers);

      expect(drifting).toEqual([]);
      await expectConsistent(repo);
    });

    // A repeated settlement is the same settlement or a conflict.
    // #495-T03
    it("refuses a settlement repeated with the same total but other parts, minutes or kind", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");
      const first = {
        aiMicroUsd: USD,
        infraMicroUsd: 500_000,
        minutes: 3,
        reviewKind: "diff" as const,
      };
      await repo.settle("job-1", first);
      const before = await repo.balance();

      for (const other of [
        { ...first, aiMicroUsd: 0, infraMicroUsd: 1_500_000 },
        { ...first, aiMicroUsd: 1_500_000, infraMicroUsd: 0 },
        { ...first, minutes: 9 },
        { ...first, reviewKind: "dynamic" as const },
      ])
        expect(await thrownCode(() => repo.settle("job-1", other))).toBe(
          "idempotency_conflict",
        );

      expect(await repo.settle("job-1", first)).toMatchObject({
        ok: true,
        created: false,
      });
      expect(await repo.balance()).toEqual(before);
      await expectConsistent(repo);
    });

    // #495-T02
    it("says a settlement is new when it wrote the usage, and a repeat or a release alone is not", async () => {
      const { repo } = await setup(engine);
      await repo.append(topUp(10 * USD));
      await repo.reserve(2 * USD, "job-1");
      await repo.reserve(2 * USD, "job-2");

      const first = await repo.settle("job-1", charge(0, USD));
      const again = await repo.settle("job-1", charge(0, USD));
      const free = await repo.settle("job-2", charge(0, 0));
      const freeAgain = await repo.settle("job-2", charge(0, 0));

      expect(first).toMatchObject({ ok: true, created: true });
      expect(again).toMatchObject({ ok: true, created: false });
      expect(free).toMatchObject({ ok: true, created: true, usage: null });
      expect(freeAgain).toMatchObject({ ok: true, created: false });
      expect(await repo.balance()).toEqual({
        balanceMicroUsd: 9 * USD,
        reservedMicroUsd: 0,
      });
    });

    // A stable order: entries written in one millisecond keep the order they were written in.
    // #495-T10
    it("lists entries of one millisecond in the order they were written, newest first, across pages", async () => {
      const { db, workspaceId } = await setup(engine);
      const repo = createBillingJournalRepository(
        db,
        workspaceId,
        () => new Date(START),
      );
      await repo.append(topUp(20 * USD));
      for (let index = 0; index < 12; index += 1) {
        await repo.reserve(USD, `job-${index}`);
        await repo.settle(`job-${index}`, charge(0, 500_000));
      }
      const written = (await repo.entries({ limit: 200 })).entries;

      const seen: string[] = [];
      let cursor: Awaited<ReturnType<typeof repo.entries>>["next"];
      do {
        const page = await repo.entries({ cursor, limit: 5 });
        seen.push(...page.entries.map((entry) => entry.id));
        cursor = page.next;
      } while (cursor !== undefined);

      expect(new Set(written.map((entry) => entry.createdAt)).size).toBe(1);
      expect(seen).toEqual(written.map((entry) => entry.id));
      // Per job the reservation comes before the release and the usage, so newest first it is the other way round.
      for (let index = 0; index < 12; index += 1) {
        const positions = ["usage", "release", "reservation"].map((type) =>
          written.findIndex(
            (entry) => entry.type === type && entry.jobId === `job-${index}`,
          ),
        );
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }
      const seqs = written.map((entry) => entry.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
      expect(new Set(seqs).size).toBe(seqs.length);
    });
  });
}

describe("two app instances on one Postgres", () => {
  const describePostgres = hasPostgres() ? describe : describe.skip;
  describePostgres("reserving through separate pools", () => {
    // #495-T05
    it("lets 20 reserves from two pools succeed exactly 3 times against a balance of 10 holds of 3", async () => {
      const first = await setup(ENGINES[1] as Engine);
      const location = first.location;
      if (!("url" in location)) throw new Error("expected a Postgres url");
      const second = connectPostgres(location.url, 8);
      const repoA = first.repo;
      const repoB = createBillingJournalRepository(
        second.db,
        first.workspaceId,
        steadyClock(),
      );
      await repoA.append(topUp(10 * USD));

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? repoA : repoB).reserve(3 * USD, `job-${index}`),
        ),
      );

      expect(results.filter((result) => result.ok)).toHaveLength(3);
      expect(await repoA.balance()).toEqual({
        balanceMicroUsd: USD,
        reservedMicroUsd: 9 * USD,
      });
      await expectConsistent(repoA);
    });
  });
});

describe("several processes on one SQLite file", () => {
  // #495-T05
  it("lets reserves from three processes succeed exactly as often as the balance covers", async () => {
    const { db, location, workspaceId, repo } = await setup(
      ENGINES[0] as Engine,
    );
    if (!("path" in location)) throw new Error("expected a SQLite path");
    await repo.append(topUp(10 * USD));
    const processes = [0, 1, 2].map((index) =>
      startDbProcess(
        [
          "reserve",
          location.path,
          workspaceId,
          String(3 * USD),
          `p${index}`,
          "7",
        ],
        join(import.meta.dirname, "../../test-support/billing-child.ts"),
      ),
    );
    for (const child of processes) expect(await child.nextLine()).toBe("ready");
    const startAt = Date.now() + 500;
    for (const child of processes) child.send(`go ${startAt}`);

    const answers = await Promise.all(
      processes.map(
        async (child) =>
          JSON.parse(await child.nextLine()) as { ok: number; refused: number },
      ),
    );

    expect(answers.reduce((total, answer) => total + answer.ok, 0)).toBe(3);
    expect(answers.reduce((total, answer) => total + answer.refused, 0)).toBe(
      18,
    );
    expect(await repo.balance()).toEqual({
      balanceMicroUsd: USD,
      reservedMicroUsd: 9 * USD,
    });
    expect(await sumOfEntries(db, workspaceId)).toBe(USD);
    await expectConsistent(repo);
  });
});
