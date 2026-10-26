// SPDX-License-Identifier: LicenseRef-Proprietary

// The start credit (#507; ADR 0006, 2.16, D11, P7): a `start_credit` entry of the amount the admin set, granted once per GitHub
// account, lazily the first time a workspace with a bound installation meets billing while billing is on. The memory of grants
// is the instance table `billing_start_credit_grants`; it has no foreign key to a workspace, so it survives the workspace.
//  The races between two processes on one database are in
// start-credit-processes.integration.test.ts.
import type { Kysely, KyselyPlugin } from "kysely";
import { sql } from "kysely";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { databaseDriver } from "../db/driver.ts";
import type { Database } from "../db/schema.ts";
import type { IntegrationStatus } from "../integrations/types.ts";
import {
  fundWorkspace,
  setBillingSwitch,
  TEST_BILLING_RATES,
} from "../test-support/billing-switch.ts";
import { afterQueryPlugin } from "../test-support/query-hook.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  ensureStartCredit,
  START_CREDIT_FAILED_LOG_CODE,
  START_CREDIT_LOG_CODE,
  START_CREDIT_REF_KEY,
} from "./start-credit.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const NOW = new Date("2026-10-21T08:00:00.000Z");
const TWO_USD = 2_000_000;
const ENGINES = ["pr-agent", "opencode"] as const;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

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
  // #506: the start credit is below the default threshold, so the workspace has a (silent) low-balance row.
  await db
    .deleteFrom("billing_notifications")
    .where("workspace_id", "=", workspaceId)
    .execute();
  await db
    .deleteFrom("integrations")
    .where("workspace_id", "=", workspaceId)
    .execute();
  await db.deleteFrom("workspaces").where("id", "=", workspaceId).execute();
}

describe("the start credit", () => {
  async function start(
    rates: Parameters<typeof setBillingSwitch>[2] = TEST_BILLING_RATES,
  ) {
    const db = await open();
    if (db === undefined) throw new Error("No database.");
    await setBillingSwitch(db, true, rates);
    return { db, workspaceId: await defaultWorkspaceId(db) };
  }

  // #507-T01
  it("grants one start credit of the configured amount to a workspace with a bound installation", async () => {
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
  });

  // #507-T01
  it("uses the default of 2 USD when the admin never set an amount", async () => {
    const { db, workspaceId } = await start();
    await bind(db, workspaceId);

    await ensureStartCredit(db, workspaceId, () => NOW);

    expect((await startCreditsOf(db, workspaceId))[0]?.amountMicroUsd).toBe(
      TWO_USD,
    );
  });

  // #507-T02
  it("writes one entry when the trigger runs twice, one after the other", async () => {
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
  });

  // #507-T02
  it("writes one entry when the trigger runs twice at the same moment", async () => {
    const { db, workspaceId } = await start();
    await bind(db, workspaceId);

    const results = await Promise.all([
      ensureStartCredit(db, workspaceId, () => NOW),
      ensureStartCredit(db, workspaceId, () => NOW),
      ensureStartCredit(db, workspaceId, () => NOW),
    ]);

    expect(results.filter((r) => r.status === "granted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_granted")).toHaveLength(
      2,
    );
    expect(await startCreditsOf(db, workspaceId)).toHaveLength(1);
    expect(await grantRows(db)).toHaveLength(1);
  });

  // #507-T03
  it("does not grant again to a workspace that is deleted and created again for the same account", async () => {
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
  });

  // #507-T04
  it("grants once in total to two workspaces bound to installations of the same GitHub account", async () => {
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
  });

  // #507-T04
  it("grants once in total when two workspaces of one account meet billing at the same moment", async () => {
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
  });

  // #507-T04
  it("grants a workspace with installations of two accounts only once, and the second account stays unused", async () => {
    const { db, workspaceId } = await start();
    await bind(db, workspaceId, { accountId: 1, installationId: "11" });
    await bind(db, workspaceId, { accountId: 2, installationId: "12" });

    await ensureStartCredit(db, workspaceId, () => NOW);
    await ensureStartCredit(db, workspaceId, () => NOW);

    expect(await startCreditsOf(db, workspaceId)).toHaveLength(1);
    expect(await grantRows(db)).toHaveLength(1);
  });

  // #507-T04
  it("grants through another account when the first one was granted to another workspace", async () => {
    const { db, workspaceId } = await start();
    const other = await addWorkspace(db, "second");
    await bind(db, other, { accountId: 1, installationId: "21" });
    await ensureStartCredit(db, other, () => NOW);
    await bind(db, workspaceId, { accountId: 1, installationId: "22" });
    await bind(db, workspaceId, { accountId: 2, installationId: "23" });

    const result = await ensureStartCredit(db, workspaceId, () => NOW);

    expect(result.status).toBe("granted");
    expect((await grantRows(db)).map((row) => row.github_account_id)).toEqual([
      "1",
      "2",
    ]);
  });

  // #507-T05
  it("grants nothing to a workspace without a bound installation", async () => {
    const { db, workspaceId } = await start();

    const result = await ensureStartCredit(db, workspaceId, () => NOW);

    expect(result.status).toBe("no_installation");
    expect(await startCreditsOf(db, workspaceId)).toHaveLength(0);
    expect(await grantRows(db)).toEqual([]);
  });

  // #507-T05
  it("grants nothing for an installation that was disconnected, or that has no account id", async () => {
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
  });

  // #507-T05
  it("refuses the claim of a workspace without a start credit for its balance, as usual", async () => {
    const database = await open();
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
  });

  // #507-T06
  it("grants nothing and writes no row when the amount is 0", async () => {
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
  it("grants a later account when the amount is raised from 0, since nothing was consumed", async () => {
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
  });

  // #507-T07
  it("gives each of several existing workspaces its grant on first contact after billing is switched on", async () => {
    const db = await open();
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
      expect((await journalOf(db, id).balance()).balanceMicroUsd).toBe(TWO_USD);
    }
    expect(await grantRows(db)).toHaveLength(3);
  });

  // #507-T08
  it("grants nothing and reads no billing table while billing is off", async () => {
    const db = await open();
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
    expect(tables.filter((table) => table.startsWith("billing_"))).toEqual([]);
    expect(tables.filter((table) => table === "integrations")).toEqual([]);
    expect(await grantRows(db)).toEqual([]);
    expect(await startCreditsOf(db, workspaceId)).toEqual([]);
  });

  // #507-T08
  it("a claim with billing off grants nothing and holds nothing", async () => {
    const database = await open();
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
  it("keeps a numeric account id, a workspace id and a time, nothing else, and no foreign key to a workspace", async () => {
    const db = await open();
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
    const foreignKeys = (
      await sql<{
        n: string;
      }>`select conname as n from pg_constraint where conrelid = 'billing_start_credit_grants'::regclass and contype = 'f'`.execute(
        db,
      )
    ).rows;
    expect(foreignKeys).toEqual([]);
  });

  // #507-T09
  it("survives the deletion of the workspace it names", async () => {
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
  it("refuses a row whose account id is not a number", async () => {
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
  it("leaves earlier grants as they were and uses the new amount for later ones", async () => {
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
  });

  // #507-T01
  it("grants at the first claim, so the credit lets that job start (nothing is held, #605), and never again", async () => {
    const database = await open();
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
    expect(entries.map((entry) => entry.type)).toEqual(["start_credit"]);
    expect(entries[0]?.amountMicroUsd).toBe(TWO_USD);
    expect(
      await journalOf(fixture.db, fixture.workspaceId).verify(),
    ).toMatchObject({ consistent: true });
  });

  /** A claim fixture on billing that is on, with the one integration of the fixture bound to GitHub account 321. */
  async function claimSetup(
    options: {
      rates?: Parameters<typeof setBillingSwitch>[2];
      plugin?: KyselyPlugin;
      refused?: string[];
    } = {},
  ) {
    const database = await open();
    if (database === undefined) throw new Error("No database.");
    const fixture = await createJobQueueFixture({
      database:
        options.plugin === undefined
          ? database
          : database.withPlugin(options.plugin),
      dynamicReview: true,
      onRefused: (refusal) => {
        options.refused?.push(refusal.errorCode);
      },
    });
    await setBillingSwitch(fixture.db, true, options.rates);
    await fixture.db
      .updateTable("integrations")
      .set({ config: JSON.stringify({ accountId: 321 }) })
      .execute();
    return fixture;
  }

  /** A statement that fails on every insert into the table (when the row matches `condition`), the way a broken database does. */
  async function failInsertsInto(
    db: Kysely<Database>,
    table: string,
    condition?: string,
  ) {
    await sql
      .raw(
        "create or replace function t507_fail() returns trigger as $$ begin raise exception 'injected failure'; end $$ language plpgsql",
      )
      .execute(db);
    await sql
      .raw(
        `create trigger t507_fail before insert on ${table} for each row ${condition === undefined ? "" : `when (${condition})`} execute function t507_fail()`,
      )
      .execute(db);
    return sql.raw(`drop trigger t507_fail on ${table}`);
  }

  const logged = (info: MockInstance<typeof console.info>, code: string) =>
    info.mock.calls.filter((call) => String(call[0]).includes(code));

  // #507-T11
  it("does not stall the claim on an integration row of a type this code does not know", async () => {
    const refused: string[] = [];
    const fixture = await claimSetup({ refused });
    await fixture.db
      .insertInto("integrations")
      .values({
        id: crypto.randomUUID(),
        workspace_id: fixture.workspaceId,
        type: "future_type",
        display_name: "from a later version",
        external_id: "future-1",
        config: "{}",
        credentials: null,
        webhook_secret: null,
        status: "active",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })
      .execute();
    await fixture.enqueueNew({ prNumber: 1 });

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    // The installation next to the poison row still earns the credit, which lets the job start.
    expect(claimed).not.toBeNull();
    expect(refused).toEqual([]);
    expect(await startCreditsOf(fixture.db, fixture.workspaceId)).toHaveLength(
      1,
    );
  });

  // #507-T11
  it("skips an installation whose config cannot be read and refuses the job for balance, as without an installation", async () => {
    const refused: string[] = [];
    const fixture = await claimSetup({ refused });
    await fixture.db
      .updateTable("integrations")
      .set({ config: "{not json" })
      .execute();
    await fixture.enqueueNew({ prNumber: 1 });

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).toBeNull();
    expect(refused).toEqual(["insufficient_balance"]);
    expect(await startCreditsOf(fixture.db, fixture.workspaceId)).toEqual([]);
    expect(await grantRows(fixture.db)).toEqual([]);
  });

  // #507-T11
  it("does not read the credentials of an installation, so a damaged secret cannot stop the grant", async () => {
    const { db, workspaceId } = await start();
    await bind(db, workspaceId, { accountId: 11 });
    await db
      .updateTable("integrations")
      .set({ credentials: "{not json", webhook_secret: null })
      .execute();
    const statements: string[] = [];
    const plugged = db.withPlugin(
      afterQueryPlugin(async (query) => {
        statements.push(`${query.kind} ${String(query.table)}`);
      }),
    );

    const result = await ensureStartCredit(plugged, workspaceId, () => NOW);

    expect(result.status).toBe("granted");
    expect(statements).toContain("select integrations");
  });

  // #507-T12
  it("claims the job without the credit when the grant fails on the grants table, and says so", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refused: string[] = [];
      const fixture = await claimSetup({ refused });
      await fundWorkspace(fixture.db, fixture.workspaceId, TWO_USD);
      const undo = await failInsertsInto(
        fixture.db,
        "billing_start_credit_grants",
      );
      await fixture.enqueueNew({ prNumber: 1 });

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      // The claim is unaffected: judged on its balance, which lets the job start.
      expect(claimed).not.toBeNull();
      expect(refused).toEqual([]);
      expect(await startCreditsOf(fixture.db, fixture.workspaceId)).toEqual([]);
      expect(await grantRows(fixture.db)).toEqual([]);
      expect(logged(info, START_CREDIT_LOG_CODE)).toEqual([]);
      const failures = warn.mock.calls.filter((call) =>
        String(call[0]).includes(START_CREDIT_FAILED_LOG_CODE),
      );
      expect(failures).toHaveLength(1);
      expect(String(failures[0]?.[0])).not.toContain("injected failure");

      // The next contact tries again, and grants once the database works.
      await undo.execute(fixture.db);
      await fixture.enqueueNew({ prNumber: 2, headSha: sha("b") });
      expect(await fixture.queue.claimNext("runner-a", ENGINES)).not.toBeNull();
      expect(
        await startCreditsOf(fixture.db, fixture.workspaceId),
      ).toHaveLength(1);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  // #507-T12
  it("takes the grants row back with the failed grant when the entry cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fixture = await claimSetup();
      const undo = await failInsertsInto(
        fixture.db,
        "billing_journal_entries",
        "NEW.type = 'start_credit'",
      );
      await fixture.enqueueNew({ prNumber: 1 });

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      // No credit and no balance: refused as usual, and the account is not consumed.
      expect(claimed).toBeNull();
      expect(await grantRows(fixture.db)).toEqual([]);
      expect(warn).toHaveBeenCalled();

      await undo.execute(fixture.db);
      await fixture.enqueueNew({ prNumber: 2, headSha: sha("b") });
      expect(await fixture.queue.claimNext("runner-a", ENGINES)).not.toBeNull();
      expect(
        (await grantRows(fixture.db)).map((row) => row.github_account_id),
      ).toEqual(["321"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // #507-T12
  it("returns a failed result and writes nothing when the grant fails outside a claim", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { db, workspaceId } = await start();
      await bind(db, workspaceId, { accountId: 5 });
      await failInsertsInto(db, "billing_start_credit_grants");

      const result = await ensureStartCredit(db, workspaceId, () => NOW);

      expect(result.status).toBe("failed");
      expect(await startCreditsOf(db, workspaceId)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // #507-T13
  it("grants nothing while billing is on but not ready (a rate is missing), and the claim is refused for the rates", async () => {
    const refused: string[] = [];
    const fixture = await claimSetup({
      refused,
      rates: { factorA: 50_000 },
    });
    await fixture.enqueueNew({ prNumber: 1 });

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).toBeNull();
    expect(refused).toEqual(["billing_rates_incomplete"]);
    const entries = await journalOf(fixture.db, fixture.workspaceId).entries({
      limit: 20,
    });
    expect(entries.entries).toEqual([]);
    expect(await grantRows(fixture.db)).toEqual([]);
  });

  // #507-T14
  it("takes the balance lock before it touches the grants table, the journal's order for every writer", async () => {
    const { db, workspaceId } = await start();
    await bind(db, workspaceId, { accountId: 77 });
    const statements: string[] = [];
    const plugged = db.withPlugin(
      afterQueryPlugin(async (query) => {
        statements.push(`${query.kind} ${String(query.table)}`);
      }),
    );

    const result = await ensureStartCredit(plugged, workspaceId, () => NOW);

    expect(result.status).toBe("granted");
    const lock = statements.indexOf("select billing_balances");
    const grant = statements.indexOf("insert billing_start_credit_grants");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(lock);
  });

  // #507-T15
  it("logs the grant once, after the claim committed, and not at all when the claim rolls back", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fixture = await claimSetup();
      const undo = await failInsertsInto(fixture.db, "usage_records");
      await fixture.enqueueNew({ prNumber: 1 });

      await expect(
        fixture.queue.claimNext("runner-a", ENGINES),
      ).rejects.toThrow();

      // The whole claim rolled back, the grant with it, and nothing was announced.
      expect(await grantRows(fixture.db)).toEqual([]);
      expect(await startCreditsOf(fixture.db, fixture.workspaceId)).toEqual([]);
      expect(logged(info, START_CREDIT_LOG_CODE)).toEqual([]);

      await undo.execute(fixture.db);
      expect(await fixture.queue.claimNext("runner-a", ENGINES)).not.toBeNull();
      expect(logged(info, START_CREDIT_LOG_CODE)).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  // #507-T15
  it("does not log a grant that a transaction of the caller rolls back", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { db, workspaceId } = await start();
      await bind(db, workspaceId, { accountId: 78 });

      await expect(
        db.transaction().execute(async (trx) => {
          const result = await ensureStartCredit(trx, workspaceId, () => NOW);
          expect(result.status).toBe("granted");
          throw new Error("the caller's transaction fails");
        }),
      ).rejects.toThrow("the caller's transaction fails");

      expect(logged(info, START_CREDIT_LOG_CODE)).toEqual([]);
      expect(await grantRows(db)).toEqual([]);

      // A call that owns its transaction logs after the commit.
      await ensureStartCredit(db, workspaceId, () => NOW);
      expect(logged(info, START_CREDIT_LOG_CODE)).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  // #507-T16
  it("tries an account that was granted before once per claim, not once per candidate job", async () => {
    const statements: string[] = [];
    const refused: string[] = [];
    const fixture = await claimSetup({
      refused,
      plugin: afterQueryPlugin(async (query) => {
        statements.push(`${query.kind} ${String(query.table)}`);
      }),
    });
    const earlier = await addWorkspace(fixture.db, "earlier");
    await fixture.db
      .insertInto("billing_start_credit_grants")
      .values({
        github_account_id: "321",
        workspace_id: earlier,
        granted_at: NOW.toISOString(),
      })
      .execute();
    await fixture.enqueueNew({ prNumber: 1 });
    await fixture.enqueueNew({ prNumber: 2, headSha: sha("b") });
    await fixture.enqueueNew({ prNumber: 3, headSha: sha("c") });
    statements.length = 0;

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).toBeNull();
    expect(refused).toEqual([
      "insufficient_balance",
      "insufficient_balance",
      "insufficient_balance",
    ]);
    expect(
      statements.filter((s) => s === "insert billing_start_credit_grants"),
    ).toHaveLength(1);
  });
});
