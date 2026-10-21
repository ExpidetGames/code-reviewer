// SPDX-License-Identifier: Apache-2.0

// The start credit (#507; ADR 0006, 2.16, D11, P7): a `start_credit` entry of the amount the admin set, granted once per GitHub
// account, lazily the first time a workspace with a bound installation meets billing while billing is on. The memory of grants
// is the instance table `billing_start_credit_grants`; it has no foreign key to a workspace, so it survives the workspace.
// On SQLite and, when TEST_DATABASE_URL is set, on Postgres. The races between two processes on one SQLite file are in
// start-credit-processes.integration.test.ts.
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { databaseDriver } from "../db/driver.ts";
import type { Database } from "../db/schema.ts";
import type { IntegrationStatus } from "../integrations/types.ts";
import {
  setBillingSwitch,
  TEST_BILLING_RATES,
} from "../test-support/billing-switch.ts";
import { afterQueryPlugin } from "../test-support/query-hook.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import { ensureStartCredit, START_CREDIT_REF_KEY } from "./start-credit.ts";

const NOW = new Date("2026-10-21T08:00:00.000Z");
const TWO_USD = 2_000_000;
const ENGINES = ["pr-agent", "opencode"] as const;

const databases: Array<
  [string, (() => Promise<Kysely<Database>>) | undefined]
> = [
  ["SQLite", async () => (await createTestDatabase()).db],
  [
    "Postgres",
    hasPostgres()
      ? async () => (await createPostgresTestDatabase({ poolMax: 12 })).db
      : undefined,
  ],
];

let installations = 0;

/** Binds a GitHub App installation of a GitHub account to a workspace, the way the binding flow stores it. */
async function bind(
  db: Kysely<Database>,
  workspaceId: string,
  options: {
    accountId?: number | string | null;
    status?: IntegrationStatus;
    installationId?: string;
  } = {},
) {
  installations += 1;
  const repository = createIntegrationsRepository(db, workspaceId, () => NOW);
  const accountId = "accountId" in options ? options.accountId : 9001;
  const integration = await repository.create({
    type: "github_app",
    displayName: `account-${String(installations)}`,
    externalId: options.installationId ?? String(7000 + installations),
    config: {
      accountLogin: `account-${String(installations)}`,
      accountType: "Organization",
      ...(accountId === null || accountId === undefined ? {} : { accountId }),
    },
  });
  if (options.status !== undefined && options.status !== "active")
    await repository.setStatus(integration.id, options.status);
  return integration;
}

const journalOf = (db: Kysely<Database>, workspaceId: string) =>
  createBillingJournalRepository(db, workspaceId, () => NOW);

async function startCreditsOf(
  db: Kysely<Database>,
  workspaceId: string,
): Promise<JournalEntry[]> {
  const { entries } = await journalOf(db, workspaceId).entries({ limit: 100 });
  return entries.filter((entry) => entry.type === "start_credit");
}

const grantRows = (db: Kysely<Database>) =>
  db
    .selectFrom("billing_start_credit_grants")
    .selectAll()
    .orderBy("github_account_id")
    .execute();

/** What an operator's `delete from workspaces` would have to do, with the journal's append-only trigger out of the way. */
async function eraseWorkspace(db: Kysely<Database>, workspaceId: string) {
  const postgres = databaseDriver(db) === "postgres";
  if (postgres)
    await sql
      .raw(
        "alter table billing_journal_entries disable trigger billing_journal_entries_immutable",
      )
      .execute(db);
  else
    await sql
      .raw("drop trigger billing_journal_entries_never_deleted")
      .execute(db);
  await db
    .deleteFrom("billing_journal_entries")
    .where("workspace_id", "=", workspaceId)
    .execute();
  await db
    .deleteFrom("billing_balances")
    .where("workspace_id", "=", workspaceId)
    .execute();
  await db
    .deleteFrom("integrations")
    .where("workspace_id", "=", workspaceId)
    .execute();
  await db.deleteFrom("workspaces").where("id", "=", workspaceId).execute();
}

describe.each(databases)("the start credit on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function start(
    rates: Parameters<typeof setBillingSwitch>[2] = TEST_BILLING_RATES,
  ) {
    const db = await open?.();
    if (db === undefined) throw new Error("No database.");
    await setBillingSwitch(db, true, rates);
    return { db, workspaceId: await defaultWorkspaceId(db) };
  }

  // #507-T01
  run(
    "grants one start credit of the configured amount to a workspace with a bound installation",
    async () => {
      const { db, workspaceId } = await start({
        ...TEST_BILLING_RATES,
        startCreditMicroUsd: 3_500_000,
      });
      await bind(db, workspaceId, { accountId: 4711 });

      const result = await ensureStartCredit(db, workspaceId, () => NOW);

      expect(result.status).toBe("granted");
      const entries = await startCreditsOf(db, workspaceId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "start_credit",
        amountMicroUsd: 3_500_000,
        refKey: START_CREDIT_REF_KEY,
        jobId: null,
        actorUserId: null,
      });
      expect(await journalOf(db, workspaceId).balance()).toEqual({
        balanceMicroUsd: 3_500_000,
        reservedMicroUsd: 0,
      });
      expect(await grantRows(db)).toEqual([
        {
          github_account_id: "4711",
          workspace_id: workspaceId,
          granted_at: NOW.toISOString(),
        },
      ]);
    },
  );

  // #507-T01
  run(
    "uses the default of 2 USD when the admin never set an amount",
    async () => {
      const { db, workspaceId } = await start();
      await bind(db, workspaceId);

      await ensureStartCredit(db, workspaceId, () => NOW);

      expect((await startCreditsOf(db, workspaceId))[0]?.amountMicroUsd).toBe(
        TWO_USD,
      );
    },
  );

  // #507-T02
  run(
    "writes one entry when the trigger runs twice, one after the other",
    async () => {
      const { db, workspaceId } = await start();
      await bind(db, workspaceId);

      const first = await ensureStartCredit(db, workspaceId, () => NOW);
      const second = await ensureStartCredit(db, workspaceId, () => NOW);

      expect(first.status).toBe("granted");
      expect(second.status).toBe("already_granted");
      expect(await startCreditsOf(db, workspaceId)).toHaveLength(1);
      expect(await grantRows(db)).toHaveLength(1);
      expect((await journalOf(db, workspaceId).balance()).balanceMicroUsd).toBe(
        TWO_USD,
      );
    },
  );

  // #507-T02
  run(
    "writes one entry when the trigger runs twice at the same moment",
    async () => {
      const { db, workspaceId } = await start();
      await bind(db, workspaceId);

      const results = await Promise.all([
        ensureStartCredit(db, workspaceId, () => NOW),
        ensureStartCredit(db, workspaceId, () => NOW),
        ensureStartCredit(db, workspaceId, () => NOW),
      ]);

      expect(results.filter((r) => r.status === "granted")).toHaveLength(1);
      expect(
        results.filter((r) => r.status === "already_granted"),
      ).toHaveLength(2);
      expect(await startCreditsOf(db, workspaceId)).toHaveLength(1);
      expect(await grantRows(db)).toHaveLength(1);
    },
  );

  // #507-T03
  run(
    "does not grant again to a workspace that is deleted and created again for the same account",
    async () => {
      const { db, workspaceId } = await start();
      const other = await addWorkspace(db, "second");
      await bind(db, other, { accountId: 555, installationId: "6001" });
      await ensureStartCredit(db, other, () => NOW);
      expect(await startCreditsOf(db, other)).toHaveLength(1);

      await eraseWorkspace(db, other);
      const created = await addWorkspace(db, "second-again");
      await bind(db, created, { accountId: 555, installationId: "6001" });
      const result = await ensureStartCredit(db, created, () => NOW);

      expect(result.status).toBe("account_already_granted");
      expect(await startCreditsOf(db, created)).toHaveLength(0);
      expect(await journalOf(db, created).balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: 0,
      });
      // The memory of the grant outlived the workspace it was made for.
      expect(await grantRows(db)).toEqual([
        {
          github_account_id: "555",
          workspace_id: other,
          granted_at: NOW.toISOString(),
        },
      ]);
      expect(workspaceId).not.toBe(created);
    },
  );

  // #507-T04
  run(
    "grants once in total to two workspaces bound to installations of the same GitHub account",
    async () => {
      const { db, workspaceId } = await start();
      const other = await addWorkspace(db, "second");
      await bind(db, workspaceId, { accountId: 31337, installationId: "1" });
      await bind(db, other, { accountId: 31337, installationId: "2" });

      const first = await ensureStartCredit(db, workspaceId, () => NOW);
      const second = await ensureStartCredit(db, other, () => NOW);

      expect([first.status, second.status]).toEqual([
        "granted",
        "account_already_granted",
      ]);
      expect(await startCreditsOf(db, workspaceId)).toHaveLength(1);
      expect(await startCreditsOf(db, other)).toHaveLength(0);
      expect(await grantRows(db)).toHaveLength(1);
    },
  );

  // #507-T04
  run(
    "grants once in total when two workspaces of one account meet billing at the same moment",
    async () => {
      const { db, workspaceId } = await start();
      const other = await addWorkspace(db, "second");
      await bind(db, workspaceId, { accountId: 31337, installationId: "1" });
      await bind(db, other, { accountId: 31337, installationId: "2" });

      const results = await Promise.all([
        ensureStartCredit(db, workspaceId, () => NOW),
        ensureStartCredit(db, other, () => NOW),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "account_already_granted",
        "granted",
      ]);
      expect(
        (await startCreditsOf(db, workspaceId)).length +
          (await startCreditsOf(db, other)).length,
      ).toBe(1);
      expect(await grantRows(db)).toHaveLength(1);
    },
  );

  // #507-T04
  run(
    "grants a workspace with installations of two accounts only once, and the second account stays unused",
    async () => {
      const { db, workspaceId } = await start();
      await bind(db, workspaceId, { accountId: 1, installationId: "11" });
      await bind(db, workspaceId, { accountId: 2, installationId: "12" });

      await ensureStartCredit(db, workspaceId, () => NOW);
      await ensureStartCredit(db, workspaceId, () => NOW);

      expect(await startCreditsOf(db, workspaceId)).toHaveLength(1);
      expect(await grantRows(db)).toHaveLength(1);
    },
  );

  // #507-T04
  run(
    "grants through another account when the first one was granted to another workspace",
    async () => {
      const { db, workspaceId } = await start();
      const other = await addWorkspace(db, "second");
      await bind(db, other, { accountId: 1, installationId: "21" });
      await ensureStartCredit(db, other, () => NOW);
      await bind(db, workspaceId, { accountId: 1, installationId: "22" });
      await bind(db, workspaceId, { accountId: 2, installationId: "23" });

      const result = await ensureStartCredit(db, workspaceId, () => NOW);

      expect(result.status).toBe("granted");
      expect((await grantRows(db)).map((row) => row.github_account_id)).toEqual(
        ["1", "2"],
      );
    },
  );

  // #507-T05
  run(
    "grants nothing to a workspace without a bound installation",
    async () => {
      const { db, workspaceId } = await start();

      const result = await ensureStartCredit(db, workspaceId, () => NOW);

      expect(result.status).toBe("no_installation");
      expect(await startCreditsOf(db, workspaceId)).toHaveLength(0);
      expect(await grantRows(db)).toEqual([]);
    },
  );

  // #507-T05
  run(
    "grants nothing for an installation that was disconnected, or that has no account id",
    async () => {
      const { db, workspaceId } = await start();
      await bind(db, workspaceId, {
        accountId: 77,
        status: "disconnected",
        installationId: "31",
      });
      await bind(db, workspaceId, { accountId: null, installationId: "32" });
      await bind(db, workspaceId, {
        accountId: "not-a-number",
        installationId: "33",
      });

      const result = await ensureStartCredit(db, workspaceId, () => NOW);

      expect(result.status).toBe("no_installation");
      expect(await grantRows(db)).toEqual([]);
    },
  );

  // #507-T05
  run(
    "refuses the claim of a workspace without a start credit for its balance, as usual",
    async () => {
      const database = await open?.();
      if (database === undefined) throw new Error("No database.");
      const refused: string[] = [];
      const fixture = await createJobQueueFixture({
        database,
        dynamicReview: true,
        onRefused: (refusal) => refused.push(refusal.errorCode),
      });
      await setBillingSwitch(fixture.db, true);
      // The fixture's installation has no account id: nothing ties it to a GitHub account.
      await fixture.enqueueNew({ prNumber: 1 });

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      expect(claimed).toBeNull();
      expect(refused).toEqual(["insufficient_balance"]);
      expect(await startCreditsOf(fixture.db, fixture.workspaceId)).toEqual([]);
    },
  );

  // #507-T06
  run("grants nothing and writes no row when the amount is 0", async () => {
    const { db, workspaceId } = await start({
      ...TEST_BILLING_RATES,
      startCreditMicroUsd: 0,
    });
    await bind(db, workspaceId);

    const result = await ensureStartCredit(db, workspaceId, () => NOW);

    expect(result.status).toBe("disabled");
    expect(await startCreditsOf(db, workspaceId)).toHaveLength(0);
    expect(await grantRows(db)).toEqual([]);
  });

  // #507-T06
  run(
    "grants a later account when the amount is raised from 0, since nothing was consumed",
    async () => {
      const { db, workspaceId } = await start({
        ...TEST_BILLING_RATES,
        startCreditMicroUsd: 0,
      });
      await bind(db, workspaceId);
      await ensureStartCredit(db, workspaceId, () => NOW);
      await setBillingSwitch(db, true, {
        ...TEST_BILLING_RATES,
        startCreditMicroUsd: TWO_USD,
      });

      const result = await ensureStartCredit(db, workspaceId, () => NOW);

      expect(result.status).toBe("granted");
    },
  );

  // #507-T07
  run(
    "gives each of several existing workspaces its grant on first contact after billing is switched on",
    async () => {
      const db = await open?.();
      if (db === undefined) throw new Error("No database.");
      const ids = [
        await defaultWorkspaceId(db),
        await addWorkspace(db, "b"),
        await addWorkspace(db, "c"),
      ];
      for (const [index, id] of ids.entries())
        await bind(db, id, { accountId: 100 + index });
      // Billing was off: nothing happened to them.
      await setBillingSwitch(db, false);
      for (const id of ids) {
        expect((await ensureStartCredit(db, id, () => NOW)).status).toBe(
          "billing_off",
        );
        expect(await startCreditsOf(db, id)).toHaveLength(0);
      }

      await setBillingSwitch(db, true);
      for (const id of ids) await ensureStartCredit(db, id, () => NOW);
      for (const id of ids) await ensureStartCredit(db, id, () => NOW);

      for (const id of ids) {
        expect(await startCreditsOf(db, id)).toHaveLength(1);
        expect((await journalOf(db, id).balance()).balanceMicroUsd).toBe(
          TWO_USD,
        );
      }
      expect(await grantRows(db)).toHaveLength(3);
    },
  );

  // #507-T08
  run(
    "grants nothing and reads no billing table while billing is off",
    async () => {
      const db = await open?.();
      if (db === undefined) throw new Error("No database.");
      const workspaceId = await defaultWorkspaceId(db);
      await bind(db, workspaceId);
      const tables: string[] = [];
      const watched = db.withPlugin(
        afterQueryPlugin(async (query) => {
          if (query.table !== undefined) tables.push(query.table);
        }),
      );

      // Never switched on, and switched on and off again.
      const never = await ensureStartCredit(watched, workspaceId, () => NOW);
      await setBillingSwitch(db, true);
      await setBillingSwitch(db, false);
      tables.length = 0;
      const off = await ensureStartCredit(watched, workspaceId, () => NOW);

      expect(never.status).toBe("billing_off");
      expect(off.status).toBe("billing_off");
      expect(tables.filter((table) => table.startsWith("billing_"))).toEqual(
        [],
      );
      expect(tables.filter((table) => table === "integrations")).toEqual([]);
      expect(await grantRows(db)).toEqual([]);
      expect(await startCreditsOf(db, workspaceId)).toEqual([]);
    },
  );

  // #507-T08
  run("a claim with billing off grants nothing and holds nothing", async () => {
    const database = await open?.();
    if (database === undefined) throw new Error("No database.");
    const fixture = await createJobQueueFixture({
      database,
      dynamicReview: true,
    });
    await fixture.db
      .updateTable("integrations")
      .set({ config: JSON.stringify({ accountId: 321 }) })
      .execute();
    await fixture.enqueueNew({ prNumber: 1 });

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).not.toBeNull();
    expect(await grantRows(fixture.db)).toEqual([]);
    expect(
      await fixture.db
        .selectFrom("billing_journal_entries")
        .selectAll()
        .execute(),
    ).toEqual([]);
  });

  // #507-T09
  run(
    "keeps a numeric account id, a workspace id and a time, nothing else, and no foreign key to a workspace",
    async () => {
      const db = await open?.();
      if (db === undefined) throw new Error("No database.");

      const tables = await db.introspection.getTables();
      const table = tables.find(
        (candidate) => candidate.name === "billing_start_credit_grants",
      );

      expect(table?.columns.map((column) => column.name).sort()).toEqual([
        "github_account_id",
        "granted_at",
        "workspace_id",
      ]);
      const foreignKeys =
        name === "Postgres"
          ? (
              await sql<{
                n: string;
              }>`select conname as n from pg_constraint where conrelid = 'billing_start_credit_grants'::regclass and contype = 'f'`.execute(
                db,
              )
            ).rows
          : (
              await sql<{
                n: string;
              }>`select "from" as n from pragma_foreign_key_list('billing_start_credit_grants')`.execute(
                db,
              )
            ).rows;
      expect(foreignKeys).toEqual([]);
    },
  );

  // #507-T09
  run("survives the deletion of the workspace it names", async () => {
    const { db } = await start();
    const other = await addWorkspace(db, "second");
    await bind(db, other, { accountId: 808 });
    await ensureStartCredit(db, other, () => NOW);

    await eraseWorkspace(db, other);

    expect(await grantRows(db)).toEqual([
      {
        github_account_id: "808",
        workspace_id: other,
        granted_at: NOW.toISOString(),
      },
    ]);
  });

  // #507-T09
  run("refuses a row whose account id is not a number", async () => {
    const { db, workspaceId } = await start();

    await expect(
      db
        .insertInto("billing_start_credit_grants")
        .values({
          github_account_id: "octocat",
          workspace_id: workspaceId,
          granted_at: NOW.toISOString(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  // #507-T10
  run(
    "leaves earlier grants as they were and uses the new amount for later ones",
    async () => {
      const { db, workspaceId } = await start({
        ...TEST_BILLING_RATES,
        startCreditMicroUsd: 2_000_000,
      });
      const later = await addWorkspace(db, "later");
      await bind(db, workspaceId, { accountId: 1 });
      await bind(db, later, { accountId: 2 });
      await ensureStartCredit(db, workspaceId, () => NOW);

      await setBillingSwitch(db, true, {
        ...TEST_BILLING_RATES,
        startCreditMicroUsd: 5_000_000,
      });
      await ensureStartCredit(db, workspaceId, () => NOW);
      await ensureStartCredit(db, later, () => NOW);

      expect(
        (await startCreditsOf(db, workspaceId)).map((e) => e.amountMicroUsd),
      ).toEqual([2_000_000]);
      expect(
        (await startCreditsOf(db, later)).map((e) => e.amountMicroUsd),
      ).toEqual([5_000_000]);
    },
  );

  // #507-T01
  run(
    "grants at the first claim, so the credit pays the hold of that job, and never again",
    async () => {
      const database = await open?.();
      if (database === undefined) throw new Error("No database.");
      const fixture = await createJobQueueFixture({
        database,
        dynamicReview: true,
      });
      await setBillingSwitch(fixture.db, true);
      await fixture.db
        .updateTable("integrations")
        .set({ config: JSON.stringify({ accountId: 321 }) })
        .execute();
      await fixture.enqueueNew({ prNumber: 1 });
      await fixture.enqueueNew({ prNumber: 2, headSha: sha("b") });

      const first = await fixture.queue.claimNext("runner-a", ENGINES);
      const second = await fixture.queue.claimNext("runner-a", ENGINES);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      const entries = (
        await journalOf(fixture.db, fixture.workspaceId).entries({ limit: 20 })
      ).entries.reverse();
      expect(entries.map((entry) => entry.type)).toEqual([
        "start_credit",
        "reservation",
        "reservation",
      ]);
      expect(entries[0]?.amountMicroUsd).toBe(TWO_USD);
      expect(
        await journalOf(fixture.db, fixture.workspaceId).verify(),
      ).toMatchObject({ consistent: true });
    },
  );
});
