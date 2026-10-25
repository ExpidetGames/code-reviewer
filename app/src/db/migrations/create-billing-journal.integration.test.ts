// SPDX-License-Identifier: LicenseRef-Proprietary

// #495: the balance journal migration. The database itself refuses an update or a delete of an entry and an entry that
// breaks the sign or the parts of its type (the repository restates both, so a direct write cannot get around it), and
// the migration adds two empty tables to a database of the last release and to an empty one.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { addWorkspace } from "../../test-support/workspaces.ts";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";
import {
  createEmptyTestDatabase,
  createTestDatabase,
} from "../../test-support/test-database.ts";

const MIGRATION = "20261019150000_create_billing_journal";
const T = "2026-10-19T08:00:00.000Z";

type Engine = {
  name: "postgres";
  /** A migrated database with one workspace; returns its id. */
  create: () => Promise<{ db: Kysely<Database>; workspaceId: string }>;
  /** A database that has run every migration but the new one, and one that is empty. */
  createBefore: () => Promise<Kysely<Database>>;
};

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < MIGRATION,
      ),
    );
  },
};

const ENGINES: Engine[] = [
  {
    name: "postgres",
    async create() {
      const { db } = await createTestDatabase();
      return { db, workspaceId: await addWorkspace(db, "journal") };
    },
    async createBefore() {
      return (await createEmptyTestDatabase()).db;
    },
  },
];

let counter = 0;

/** One entry as stored, with the values of a valid top-up unless overridden. */
function row(workspaceId: string, overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    id: `entry-${counter}`,
    workspace_id: workspaceId,
    type: "top_up",
    amount_micro_usd: 10_000_000,
    ref_key: `ref-${counter}`,
    job_id: null,
    review_kind: null,
    minutes: null,
    ai_micro_usd: null,
    infra_micro_usd: null,
    reverses_entry_id: null,
    provider: null,
    provider_ref: null,
    actor_user_id: null,
    note: null,
    created_at: T,
    ...overrides,
  };
}

async function insert(
  db: Kysely<Database>,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  await db
    .insertInto("billing_journal_entries")
    .values(row(workspaceId, overrides))
    .execute();
}

async function count(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{
    n: string;
  }>`select count(*) as n from billing_journal_entries`.execute(db);
  return Number(rows[0]?.n);
}

for (const engine of ENGINES) {
  describe(`the balance journal table on ${engine.name}`, () => {
    // #495-T04
    it("refuses an update of an entry, whatever the column, even to the value it has", async () => {
      const { db, workspaceId } = await engine.create();
      await insert(db, workspaceId, { id: "kept", note: "first" });

      for (const statement of [
        sql`update billing_journal_entries set note = 'changed' where id = 'kept'`,
        sql`update billing_journal_entries set amount_micro_usd = 1 where id = 'kept'`,
        sql`update billing_journal_entries set note = note where id = 'kept'`,
        sql`update billing_journal_entries set workspace_id = workspace_id`,
      ])
        await expect(statement.execute(db)).rejects.toThrow(
          /billing_journal_entries_immutable/,
        );

      expect(
        await db
          .selectFrom("billing_journal_entries")
          .select(["note", "amount_micro_usd"])
          .where("id", "=", "kept")
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ note: "first" });
    });

    // #495-T04
    it("refuses a delete of an entry, one or all", async () => {
      const { db, workspaceId } = await engine.create();
      await insert(db, workspaceId, { id: "kept" });

      await expect(
        sql`delete from billing_journal_entries where id = 'kept'`.execute(db),
      ).rejects.toThrow(/billing_journal_entries_immutable/);
      await expect(
        sql`delete from billing_journal_entries`.execute(db),
      ).rejects.toThrow(/billing_journal_entries_immutable/);

      expect(await count(db)).toBe(1);
    });

    // #495-T04
    it("refuses a truncate of the journal, plain and through a cascade from the workspaces", async () => {
      const { db, workspaceId } = await engine.create();
      await insert(db, workspaceId, { id: "kept" });

      for (const statement of [
        sql`truncate billing_journal_entries`,
        sql`truncate billing_journal_entries cascade`,
        sql`truncate workspaces cascade`,
      ])
        await expect(statement.execute(db)).rejects.toThrow(
          /billing_journal_entries_immutable/,
        );

      expect(await count(db)).toBe(1);
    });

    // #495-T04
    it("refuses an upsert that would rewrite an entry", async () => {
      const { db, workspaceId } = await engine.create();
      await insert(db, workspaceId, { id: "kept", ref_key: "pi_1" });

      await expect(
        db
          .insertInto("billing_journal_entries")
          .values(row(workspaceId, { id: "kept", note: "rewritten" }))
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({ note: "rewritten" }),
          )
          .execute(),
      ).rejects.toThrow(/billing_journal_entries_immutable/);

      expect(
        (
          await db
            .selectFrom("billing_journal_entries")
            .select("note")
            .where("id", "=", "kept")
            .executeTakeFirstOrThrow()
        ).note,
      ).toBeNull();
    });

    // #495-T04
    it("leaves the balance cache writable: only the journal is immutable", async () => {
      const { db, workspaceId } = await engine.create();
      await db
        .insertInto("billing_balances")
        .values({
          workspace_id: workspaceId,
          balance_micro_usd: 5,
          reserved_micro_usd: 0,
          updated_at: T,
        })
        .execute();

      await db
        .updateTable("billing_balances")
        .set({ balance_micro_usd: 9 })
        .where("workspace_id", "=", workspaceId)
        .execute();

      expect(
        Number(
          (
            await db
              .selectFrom("billing_balances")
              .select("balance_micro_usd")
              .executeTakeFirstOrThrow()
          ).balance_micro_usd,
        ),
      ).toBe(9);
    });

    // #495-T07
    it.each([
      ["a top-up that is negative", { amount_micro_usd: -1 }],
      ["a top-up of zero", { amount_micro_usd: 0 }],
      [
        "a start credit that is negative",
        { type: "start_credit", amount_micro_usd: -1 },
      ],
      [
        "a release that is negative",
        { type: "release", amount_micro_usd: -1, job_id: "j" },
      ],
      [
        "a reservation that is positive",
        { type: "reservation", amount_micro_usd: 1, job_id: "j" },
      ],
      ["a refund that is positive", { type: "refund", amount_micro_usd: 1 }],
      [
        "a chargeback that is positive",
        { type: "chargeback", amount_micro_usd: 1 },
      ],
      ["a correction of zero", { type: "correction", amount_micro_usd: 0 }],
      ["a type nobody knows", { type: "gift" }],
    ] as const)(
      "refuses %s by the sign check of the table",
      async (_name, overrides) => {
        const { db, workspaceId } = await engine.create();

        await expect(insert(db, workspaceId, overrides)).rejects.toThrow(
          /billing_journal_entries_(sign|type)_check/,
        );

        expect(await count(db)).toBe(0);
      },
    );

    // #495-T07
    it.each([
      [
        "a usage whose parts do not add up",
        { ai_micro_usd: 100, infra_micro_usd: 100 },
      ],
      [
        "a usage without its parts",
        { ai_micro_usd: null, infra_micro_usd: null },
      ],
      [
        "a usage with a negative part",
        { ai_micro_usd: -100, infra_micro_usd: 400 },
      ],
    ] as const)(
      "refuses %s by the usage check of the table",
      async (_name, parts) => {
        const { db, workspaceId } = await engine.create();

        await expect(
          insert(db, workspaceId, {
            type: "usage",
            amount_micro_usd: -300,
            job_id: "job-1",
            ref_key: "job-1",
            ...parts,
          }),
        ).rejects.toThrow(/billing_journal_entries_usage_check/);

        expect(await count(db)).toBe(0);
      },
    );

    // #495-T07
    it("refuses parts on a type that has none, a reversal on a type that is not a correction, a job entry without a job", async () => {
      const { db, workspaceId } = await engine.create();

      await expect(
        insert(db, workspaceId, { ai_micro_usd: 1, infra_micro_usd: 1 }),
      ).rejects.toThrow(/billing_journal_entries_usage_check/);
      await insert(db, workspaceId, { id: "original" });
      await expect(
        insert(db, workspaceId, { reverses_entry_id: "original" }),
      ).rejects.toThrow(/billing_journal_entries_reverses_check/);
      await expect(
        insert(db, workspaceId, { type: "release", amount_micro_usd: 5 }),
      ).rejects.toThrow(/billing_journal_entries_job_check/);

      expect(await count(db)).toBe(1);
    });

    // #495-T07
    it("accepts a correction of either sign and a usage whose parts add up", async () => {
      const { db, workspaceId } = await engine.create();

      await insert(db, workspaceId, {
        type: "correction",
        amount_micro_usd: 5,
      });
      await insert(db, workspaceId, {
        type: "correction",
        amount_micro_usd: -5,
      });
      await insert(db, workspaceId, {
        type: "usage",
        amount_micro_usd: -300,
        job_id: "job-1",
        ref_key: "job-1",
        ai_micro_usd: 100,
        infra_micro_usd: 200,
      });

      expect(await count(db)).toBe(3);
    });

    // #495-T01 (the key of D14)
    it("keeps one entry per workspace, type and key, and one reversal per entry", async () => {
      const { db, workspaceId } = await engine.create();
      await insert(db, workspaceId, { id: "e1", ref_key: "pi_1" });

      await expect(
        insert(db, workspaceId, { ref_key: "pi_1" }),
      ).rejects.toThrow(/unique/i);
      // Another type under the same key is another entry.
      await insert(db, workspaceId, {
        type: "refund",
        amount_micro_usd: -5,
        ref_key: "pi_1",
      });

      // #495-T09 at the table: a reversal is reversed once.
      await insert(db, workspaceId, {
        type: "correction",
        amount_micro_usd: -10_000_000,
        reverses_entry_id: "e1",
      });
      await expect(
        insert(db, workspaceId, {
          type: "correction",
          amount_micro_usd: -10_000_000,
          reverses_entry_id: "e1",
        }),
      ).rejects.toThrow(/unique/i);
    });

    // #495-T14
    it("migrates up from the schema of the last release and from empty, adding two empty tables and changing no row", async () => {
      const db = await engine.createBefore();
      await migrateToLatest(db, beforeThisMigration);
      const workspaceId = await addWorkspace(db, "before");
      const before = await db.selectFrom("workspaces").selectAll().execute();

      await migrateToLatest(db);

      expect(
        withoutColumnsAddedLater(
          "workspaces",
          await db.selectFrom("workspaces").selectAll().execute(),
        ),
      ).toEqual(before);
      expect(
        await db.selectFrom("billing_journal_entries").selectAll().execute(),
      ).toEqual([]);
      expect(
        await db.selectFrom("billing_balances").selectAll().execute(),
      ).toEqual([]);
      // The new tables work on the migrated database.
      await insert(db, workspaceId);
      expect(await count(db)).toBe(1);
    });

    // #495-T14
    it("migrates from an empty database in one run", async () => {
      const db = await engine.createBefore();

      await migrateToLatest(db);

      expect(
        await db.selectFrom("billing_balances").selectAll().execute(),
      ).toEqual([]);
      const names = (
        await sql<{
          name: string;
        }>`select name from kysely_migration order by name`.execute(db)
      ).rows.map((migrated) => migrated.name);
      expect(names).toContain(MIGRATION);
    });
  });
}
