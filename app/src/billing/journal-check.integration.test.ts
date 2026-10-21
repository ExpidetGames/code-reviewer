// SPDX-License-Identifier: Apache-2.0

// The scheduled check of the journal (#626, #510 item 7): `verify()` of every workspace that has a journal, once a day while billing is on,
// in bounded steps that resume where the last one stopped. A pass that finds the cache and the journal apart (or a hold that nobody
// released) leaves a stable code in the log and its result in the instance setting `billing_journal_check`, which the admin billing
// page shows. While billing is off nothing but the switch is read. On SQLite and, when TEST_DATABASE_URL is set, on Postgres.
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import { describe, expect, it, vi } from "vitest";
import {
  createBillingJournalRepository,
  type JournalVerification,
} from "../db/repositories/billing-journal-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { describeQuery } from "../test-support/query-hook.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import {
  JOURNAL_CHECK_INTERVAL_MS,
  readJournalCheck,
  runJournalCheck,
  runJournalCheckWhileBillingOn,
} from "./journal-check.ts";

const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-10-21T03:00:00.000Z");
const USD = 1_000_000;

const databases: Array<
  [string, (() => Promise<Kysely<Database>>) | undefined]
> = [
  ["SQLite", async () => (await createTestDatabase()).db],
  [
    "Postgres",
    hasPostgres()
      ? async () => (await createPostgresTestDatabase({ poolMax: 6 })).db
      : undefined,
  ],
];

/** A clock the test moves; the check reads it for the time of a pass and for its budget. */
function clock(start = START) {
  let at = start;
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function lines() {
  const info: string[] = [];
  const error: string[] = [];
  return {
    log: {
      info: (line: string) => info.push(line),
      error: (line: string) => error.push(line),
    },
    info,
    error,
  };
}

/** Workspaces with a funded journal; returns their ids in the order the check walks them. */
async function fundedWorkspaces(db: Kysely<Database>, count: number) {
  const ids: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const id = await addWorkspace(db, `check-${String(n)}`);
    await fundWorkspace(db, id, 5 * USD);
    ids.push(id);
  }
  return ids.sort();
}

/** The cache and the journal apart: the balance row says more than the journal adds up to. */
async function corruptBalance(
  db: Kysely<Database>,
  workspaceId: string,
  by = 7_777_777,
) {
  await sql`update billing_balances set balance_micro_usd = balance_micro_usd + ${by} where workspace_id = ${workspaceId}`.execute(
    db,
  );
}

function recordTables(tables: string[]): KyselyPlugin {
  return {
    transformQuery({ node }) {
      const table = describeQuery(node).table;
      if (table !== undefined) tables.push(table);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

describe.each(databases)(
  "the scheduled check of the journal on %s",
  (_engine, open) => {
    const it_ = open === undefined ? it.skip : it;

    // #626-T10
    it_(
      "checks every workspace that has a journal, records an ok pass with its date and logs it",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const ids = await fundedWorkspaces(db, 3);
        const time = clock();
        const out = lines();

        const run = await runJournalCheck(db, { now: time.now, log: out.log });

        expect(run).toEqual({ skipped: null, checked: 3, finished: true });
        expect(await readJournalCheck(db)).toEqual({
          state: "ok",
          checkedAt: "2026-10-21T03:00:00.000Z",
          workspaces: ids.length,
          inconsistentWorkspaces: 0,
        });
        expect(out.error).toEqual([]);
        expect(out.info).toEqual([
          "[billing] BILLING_JOURNAL_CHECK_DONE result=ok workspaces=3 inconsistent=0",
        ]);
      },
    );

    // #626-T10
    it_(
      "an instance with no journal is checked at once and is ok",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);

        const run = await runJournalCheck(db, {
          now: clock().now,
          log: lines().log,
        });

        expect(run).toEqual({ skipped: null, checked: 0, finished: true });
        expect(await readJournalCheck(db)).toMatchObject({
          state: "ok",
          workspaces: 0,
        });
      },
    );

    // #626-T11
    it_(
      "records an inconsistent pass, names the workspace and the kind in a stable code, and shows no amount",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const ids = await fundedWorkspaces(db, 3);
        const bad = ids[1]!;
        await corruptBalance(db, bad, 7_777_777);
        const time = clock();
        const out = lines();

        const run = await runJournalCheck(db, { now: time.now, log: out.log });

        expect(run).toEqual({ skipped: null, checked: 3, finished: true });
        expect(await readJournalCheck(db)).toEqual({
          state: "inconsistent",
          checkedAt: "2026-10-21T03:00:00.000Z",
          workspaces: 3,
          inconsistentWorkspaces: 1,
        });
        expect(out.error).toEqual([
          `[billing] BILLING_JOURNAL_INCONSISTENT workspace=${bad} balance_drift=1 reserved_drift=0 stranded_holds=0`,
        ]);
        expect(out.info).toEqual([
          "[billing] BILLING_JOURNAL_CHECK_DONE result=inconsistent workspaces=3 inconsistent=1",
        ]);
        // No amount: neither the drift, nor a balance.
        expect(JSON.stringify([out.info, out.error])).not.toMatch(
          /7777777|7_777_777|5000000/,
        );
      },
    );

    // #626-T11
    it_(
      "shows a reserved amount that the journal does not explain as inconsistent too",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const [id] = await fundedWorkspaces(db, 1);
        await sql`update billing_balances set reserved_micro_usd = 1000 where workspace_id = ${id!}`.execute(
          db,
        );
        const out = lines();

        await runJournalCheck(db, { now: clock().now, log: out.log });

        expect(out.error).toEqual([
          `[billing] BILLING_JOURNAL_INCONSISTENT workspace=${id!} balance_drift=0 reserved_drift=1 stranded_holds=0`,
        ]);
      },
    );

    // #626-T11
    it_(
      "keeps the inconsistent result until the next pass finds it fixed, and then says ok",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const [id] = await fundedWorkspaces(db, 1);
        await corruptBalance(db, id!, 5);
        const time = clock();
        await runJournalCheck(db, { now: time.now, log: lines().log });
        await sql`update billing_balances set balance_micro_usd = balance_micro_usd - 5 where workspace_id = ${id!}`.execute(
          db,
        );

        // Within the day nothing is checked again: the answer stays.
        time.advance(HOUR);
        const early = await runJournalCheck(db, {
          now: time.now,
          log: lines().log,
        });
        expect(early).toEqual({
          skipped: "not_due",
          checked: 0,
          finished: false,
        });
        expect(await readJournalCheck(db)).toMatchObject({
          state: "inconsistent",
        });

        time.advance(JOURNAL_CHECK_INTERVAL_MS);
        await runJournalCheck(db, { now: time.now, log: lines().log });

        expect(await readJournalCheck(db)).toEqual({
          state: "ok",
          checkedAt: "2026-10-22T04:00:00.000Z",
          workspaces: 1,
          inconsistentWorkspaces: 0,
        });
      },
    );

    // #626-T11
    it_(
      "looks at a workspace that shows a difference a second time, so a write that landed between two reads is not an alarm",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const [id] = await fundedWorkspaces(db, 1);
        const real = createBillingJournalRepository(db, id!).verify;
        const verify = vi
          .fn<(workspaceId: string) => Promise<JournalVerification>>()
          .mockImplementationOnce(async () => ({
            ...(await real()),
            differenceMicroUsd: 1,
            consistent: false,
          }))
          .mockImplementation(() => real());
        const out = lines();

        await runJournalCheck(db, { now: clock().now, log: out.log, verify });

        expect(verify).toHaveBeenCalledTimes(2);
        expect(out.error).toEqual([]);
        expect(await readJournalCheck(db)).toMatchObject({ state: "ok" });
      },
    );

    // #626-T12
    it_(
      "does one step of a bounded size per run and resumes where it stopped; the pass ends with the last step",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const ids = await fundedWorkspaces(db, 5);
        await corruptBalance(db, ids[4]!);
        const time = clock();
        const verify = vi.fn((workspaceId: string) =>
          createBillingJournalRepository(db, workspaceId).verify(),
        );
        // A budget of nothing: one batch, then the run stops.
        const options = {
          now: time.now,
          log: lines().log,
          batch: 2,
          budgetMs: 0,
          verify,
        };

        const first = await runJournalCheck(db, options);
        expect(first).toEqual({ skipped: null, checked: 2, finished: false });
        expect(verify.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 2));
        expect(await readJournalCheck(db)).toMatchObject({ state: "never" });

        const second = await runJournalCheck(db, options);
        expect(second).toEqual({ skipped: null, checked: 2, finished: false });
        expect(verify.mock.calls.map(([id]) => id).slice(2)).toEqual(
          ids.slice(2, 4),
        );

        const third = await runJournalCheck(db, options);
        expect(third).toMatchObject({ checked: 1, finished: true });
        expect(await readJournalCheck(db)).toMatchObject({
          state: "inconsistent",
          workspaces: 5,
          inconsistentWorkspaces: 1,
        });
        // Every workspace was verified once (the one with a difference once more, to be sure).
        expect(verify).toHaveBeenCalledTimes(6);
      },
    );

    // #626-T12
    it_(
      "keeps the result of the last finished pass while the next one is under way",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const ids = await fundedWorkspaces(db, 3);
        const time = clock();
        await runJournalCheck(db, { now: time.now, log: lines().log });
        await corruptBalance(db, ids[0]!);
        time.advance(JOURNAL_CHECK_INTERVAL_MS);

        const partial = await runJournalCheck(db, {
          now: time.now,
          log: lines().log,
          batch: 1,
          budgetMs: 0,
        });

        expect(partial).toMatchObject({ checked: 1, finished: false });
        expect(await readJournalCheck(db)).toMatchObject({
          state: "ok",
          checkedAt: "2026-10-21T03:00:00.000Z",
        });
      },
    );

    // #626-T12
    it_(
      "starts again when the pass that was under way is older than three days",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        const ids = await fundedWorkspaces(db, 3);
        const time = clock();
        const verify = vi.fn((workspaceId: string) =>
          createBillingJournalRepository(db, workspaceId).verify(),
        );
        await runJournalCheck(db, {
          now: time.now,
          log: lines().log,
          batch: 2,
          budgetMs: 0,
          verify,
        });
        verify.mockClear();

        time.advance(4 * 24 * HOUR);
        await runJournalCheck(db, {
          now: time.now,
          log: lines().log,
          batch: 2,
          budgetMs: 0,
          verify,
        });

        // From the first workspace again, not from where the old pass stopped.
        expect(verify.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 2));
      },
    );

    // #626-T13
    it_(
      "checks nothing while billing is off, writes nothing, and reads only the switch",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, false);
        await fundedWorkspaces(db, 2);
        const tables: string[] = [];
        const verify = vi.fn();
        const out = lines();

        const run = await runJournalCheckWhileBillingOn(
          db.withPlugin(recordTables(tables)),
          { now: clock().now, log: out.log, verify },
        );

        expect(run).toEqual({ skipped: "off", checked: 0, finished: false });
        expect(verify).not.toHaveBeenCalled();
        expect(tables).toEqual(["instance_settings"]);
        expect(
          await createInstanceSettingsRepository(db).get(
            "billing_journal_check",
          ),
        ).toBeUndefined();
        expect(out.info).toEqual([]);
        expect(out.error).toEqual([]);
      },
    );

    // #626-T13
    it_("does not check without any billing setting either", async () => {
      const db = await open!();
      const verify = vi.fn();

      const run = await runJournalCheckWhileBillingOn(db, {
        now: clock().now,
        log: lines().log,
        verify,
      });

      expect(run.skipped).toBe("off");
      expect(verify).not.toHaveBeenCalled();
    });

    // #626-T13
    it_("checks while billing is on", async () => {
      const db = await open!();
      await setBillingSwitch(db, true);
      await fundedWorkspaces(db, 2);

      const run = await runJournalCheckWhileBillingOn(db, {
        now: clock().now,
        log: lines().log,
      });

      expect(run).toEqual({ skipped: null, checked: 2, finished: true });
    });

    // #626-T13
    it_(
      "is not checked in a pass that was under way when billing was switched off, until it is on again",
      async () => {
        const db = await open!();
        await setBillingSwitch(db, true);
        await fundedWorkspaces(db, 3);
        const time = clock();
        await runJournalCheckWhileBillingOn(db, {
          now: time.now,
          log: lines().log,
          batch: 2,
          budgetMs: 0,
        });
        await setBillingSwitch(db, false);

        const off = await runJournalCheckWhileBillingOn(db, {
          now: time.now,
          log: lines().log,
        });
        await setBillingSwitch(db, true);
        time.advance(HOUR);
        const on = await runJournalCheckWhileBillingOn(db, {
          now: time.now,
          log: lines().log,
        });

        expect(off.skipped).toBe("off");
        expect(on).toMatchObject({ checked: 1, finished: true });
      },
    );

    // #626-T14
    it_("reads a damaged stored state as no check ever made", async () => {
      const db = await open!();
      const settings = createInstanceSettingsRepository(db);

      for (const damaged of [
        "ok",
        7,
        [],
        {
          last: {
            at: "yesterday",
            result: "ok",
            workspaces: 1,
            inconsistent: 0,
          },
        },
        {
          last: {
            at: "2026-10-21T03:00:00.000Z",
            result: "fine",
            workspaces: 1,
            inconsistent: 0,
          },
        },
        {
          last: {
            at: "2026-10-21T03:00:00.000Z",
            result: "ok",
            workspaces: -1,
            inconsistent: 0,
          },
        },
      ]) {
        await settings.set("billing_journal_check", damaged as never, null);
        expect(await readJournalCheck(db), JSON.stringify(damaged)).toEqual({
          state: "never",
          checkedAt: null,
          workspaces: 0,
          inconsistentWorkspaces: 0,
        });
      }
    });
  },
);
