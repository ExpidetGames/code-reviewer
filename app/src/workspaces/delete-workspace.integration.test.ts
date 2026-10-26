// SPDX-License-Identifier: LicenseRef-Proprietary

// Deleting a workspace (#658), against a real database: the typed name
// and the Owner role are needed, a positive balance refuses, everything of the workspace goes (checked over every table
// that has a `workspace_id`, so a table added later cannot be forgotten), the money history stays, and a second workspace
// is not touched by a single row.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createUnclaimedInstallationsRepository } from "../db/repositories/unclaimed-installations-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import {
  createWorkspaceDeletion,
  DELETED_WORKSPACE_NAME,
  type DeleteWorkspaceResult,
} from "./delete-workspace.ts";
import { PENDING_TOP_UP_WINDOW_MS } from "../billing/topup-intent.ts";
import {
  addUser,
  seedWorkspaceForDeletion,
} from "../test-support/workspace-deletion-fixture.ts";

const NOW = new Date("2026-10-23T12:00:00.000Z");

/** The tables that name a workspace in a `workspace_id` column, whatever they are, from the schema itself. */
async function tablesWithWorkspaceId(db: Kysely<Database>): Promise<string[]> {
  const tables = await db.introspection.getTables();
  return tables
    .filter((table) =>
      table.columns.some((column) => column.name === "workspace_id"),
    )
    .map((table) => table.name)
    .sort();
}

/** What stays after a deletion, each for a reason (src/db/repositories/workspace-erasure-repository.ts). */
const KEPT = [
  "billing_balances",
  "billing_profiles",
  "billing_journal_entries",
  "billing_start_credit_grants",
  "billing_topup_intents",
  "billing_webhook_events",
  "workspaces",
];

async function countsOf(db: Kysely<Database>, workspaceId: string) {
  const counts: Record<string, number> = {};
  for (const table of await tablesWithWorkspaceId(db)) {
    const row = await sql<{
      n: string | number;
    }>`select count(*) as n from ${sql.table(table)} where workspace_id = ${workspaceId}`.execute(
      db,
    );
    counts[table] = Number(row.rows[0]?.n ?? 0);
  }
  return counts;
}

/** Every row that hangs off a job, reached through the workspace's jobs, for the tables without a workspace column. */
async function jobChildren(db: Kysely<Database>, workspaceId: string) {
  const jobIds = db
    .selectFrom("jobs")
    .select("id")
    .where("workspace_id", "=", workspaceId);
  return {
    comments: await db
      .selectFrom("job_comments")
      .selectAll()
      .where("job_id", "in", jobIds)
      .execute(),
    dispatches: await db
      .selectFrom("job_dispatches")
      .selectAll()
      .where("job_id", "in", jobIds)
      .execute(),
    projects: await db
      .selectFrom("projects")
      .innerJoin("repositories", "repositories.id", "projects.repository_id")
      .selectAll("projects")
      .where("repositories.workspace_id", "=", workspaceId)
      .execute(),
  };
}

async function snapshot(db: Kysely<Database>, workspaceId: string) {
  const out: Record<string, unknown> = {};
  for (const table of await tablesWithWorkspaceId(db))
    out[table] = (
      await sql`select * from ${sql.table(table)} where workspace_id = ${workspaceId} order by 1, 2`.execute(
        db,
      )
    ).rows;
  out.children = await jobChildren(db, workspaceId);
  out.members = await db
    .selectFrom("workspace_members")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .execute();
  return out;
}

function suite(engine: BillingEngine) {
  describe(`deleting a workspace on ${engine.name}`, () => {
    async function start(
      options: { balanceMicroUsd?: number; otherBalanceMicroUsd?: number } = {},
    ) {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      const a = await seedWorkspaceForDeletion(db, workspaceId, "a", {
        balanceMicroUsd: options.balanceMicroUsd ?? 0,
      });
      const b = await seedWorkspaceForDeletion(db, otherWorkspaceId, "b", {
        balanceMicroUsd: options.otherBalanceMicroUsd ?? 2_000_000,
      });
      const logs: string[] = [];
      const deletion = createWorkspaceDeletion({
        db,
        now: () => NOW,
        log: (message) => logs.push(message),
      });
      const remove = (
        input: { actorId?: string; confirmName?: unknown } = {},
      ): Promise<DeleteWorkspaceResult> =>
        deletion.delete({
          workspaceId,
          actorId: input.actorId ?? "owner-a",
          confirmName: "confirmName" in input ? input.confirmName : "billing-a",
        });
      return { db, a, b, workspaceId, otherWorkspaceId, remove, logs };
    }

    // #658-T03
    it("removes the workspace's data when the Owner types its name, and keeps the money history", async () => {
      const { db, workspaceId, remove, logs } = await start();
      const journalBefore = await db
        .selectFrom("billing_journal_entries")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("seq")
        .execute();
      const intentsBefore = await db
        .selectFrom("billing_topup_intents")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .execute();
      expect(journalBefore.length).toBeGreaterThan(0);

      expect(await remove()).toEqual({ ok: true });

      const counts = await countsOf(db, workspaceId);
      for (const [table, count] of Object.entries(counts))
        if (!KEPT.includes(table))
          expect(count, `${table} still holds rows`).toBe(0);
      expect(counts.billing_journal_entries).toBe(journalBefore.length);
      expect(
        await db
          .selectFrom("billing_journal_entries")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .orderBy("seq")
          .execute(),
      ).toEqual(journalBefore);
      expect(
        await db
          .selectFrom("billing_topup_intents")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .execute(),
      ).toEqual(intentsBefore);
      expect(await jobChildren(db, workspaceId)).toEqual({
        comments: [],
        dispatches: [],
        projects: [],
      });
      expect(
        await db
          .selectFrom("billing_balances")
          .select("balance_micro_usd")
          .where("workspace_id", "=", workspaceId)
          .executeTakeFirstOrThrow()
          .then((row) => Number(row.balance_micro_usd)),
      ).toBe(0);
      expect(logs).toEqual([
        `[workspaces] workspace ${workspaceId} was deleted by owner-a.`,
      ]);
    });

    // #658-T03
    it("anonymises the workspace row and frees its address and the default-workspace role", async () => {
      const { db, workspaceId, remove } = await start();

      await remove();

      const row = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        name: DELETED_WORKSPACE_NAME,
        slug: `deleted-${workspaceId}`,
        created_by: null,
        deleted_at: NOW.toISOString(),
      });
      const workspaces = createWorkspacesRepository(db);
      expect(await workspaces.slugExists("billing-a")).toBe(false);
      expect(await workspaces.findMembership("owner-a", "billing-a")).toBe(
        undefined,
      );
      expect(await workspaces.listForUser("owner-a")).toEqual([]);
      expect((await workspaces.findDefault())?.id).not.toBe(workspaceId);
      // The default workspace, the other one and the deleted one: the deleted one is not counted.
      expect(await workspaces.count()).toBe(2);
    });

    // #658-T03
    it("releases the GitHub installations: the connection is gone and the installation is noted as unclaimed", async () => {
      const { db, workspaceId, remove } = await start();

      await remove();

      expect(
        await createIntegrationsRepository(db, workspaceId).list(),
      ).toEqual([]);
      expect(
        await createUnclaimedInstallationsRepository(db).get("installation-a"),
      ).toMatchObject({ accountLogin: "acme-a", accountType: "Organization" });
      // Another workspace can link the installation now (the unique index no longer holds it).
      expect(
        (await createIntegrationsRepository(db, workspaceId).list()).length,
      ).toBe(0);
    });

    // #658-T03
    it("cancels the pending jobs: the queued job is gone, so no runner can claim it", async () => {
      const { db, a, remove } = await start();
      expect(
        await db
          .selectFrom("jobs")
          .select("id")
          .where("id", "=", a.queuedJobId)
          .executeTakeFirst(),
      ).toBeDefined();

      await remove();

      expect(
        await db
          .selectFrom("jobs")
          .select("id")
          .where("workspace_id", "=", a.workspaceId)
          .execute(),
      ).toEqual([]);
    });

    // #658-T05
    it("does not touch a single row of another workspace", async () => {
      const { db, otherWorkspaceId, remove } = await start();
      const before = await snapshot(db, otherWorkspaceId);
      const workspaceBefore = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", otherWorkspaceId)
        .executeTakeFirstOrThrow();

      expect(await remove()).toEqual({ ok: true });

      expect(await snapshot(db, otherWorkspaceId)).toEqual(before);
      expect(
        await db
          .selectFrom("workspaces")
          .selectAll()
          .where("id", "=", otherWorkspaceId)
          .executeTakeFirstOrThrow(),
      ).toEqual(workspaceBefore);
      // The comparison above is over real data: the other workspace still has its two jobs and its journal.
      const counts = await countsOf(db, otherWorkspaceId);
      expect(counts.jobs).toBe(2);
      expect(counts.billing_journal_entries).toBeGreaterThan(0);
    });

    // #658-T03
    it("needs the typed name, exactly (the ends are trimmed), and changes nothing without it", async () => {
      const { db, workspaceId, remove } = await start();
      const before = await snapshot(db, workspaceId);

      for (const confirmName of [undefined, 42, "", "billing-A", "billing"])
        expect(await remove({ confirmName })).toEqual({
          ok: false,
          error: "name_mismatch",
        });

      expect(await snapshot(db, workspaceId)).toEqual(before);
      expect(await remove({ confirmName: "  billing-a  " })).toEqual({
        ok: true,
      });
    });

    // #658-T02
    it("is the Owner's alone: an Admin and a stranger are refused and nothing changes", async () => {
      const { db, workspaceId, remove } = await start();
      await addUser(db, "stranger");
      const before = await snapshot(db, workspaceId);

      expect(await remove({ actorId: "admin-a" })).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(await remove({ actorId: "stranger" })).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(await remove({ actorId: "owner-b" })).toEqual({
        ok: false,
        error: "not_found",
      });

      expect(await snapshot(db, workspaceId)).toEqual(before);
    });

    // #658-T04
    it("is refused while the balance is positive, whatever else is true, and changes nothing", async () => {
      const { db, workspaceId, remove } = await start({
        balanceMicroUsd: 1,
      });
      const before = await snapshot(db, workspaceId);

      expect(await remove()).toEqual({ ok: false, error: "balance_positive" });

      expect(await snapshot(db, workspaceId)).toEqual(before);
      expect(
        (
          await db
            .selectFrom("workspaces")
            .select("name")
            .where("id", "=", workspaceId)
            .executeTakeFirstOrThrow()
        ).name,
      ).not.toBe(DELETED_WORKSPACE_NAME);
    });

    // #658-T04
    it("is allowed only at a balance of exactly zero: below it the open amount is settled first", async () => {
      const { db, workspaceId, remove } = await start();
      const before = await snapshot(db, workspaceId);
      await createBillingJournalRepository(db, workspaceId).append({
        type: "correction",
        amountMicroUsd: -3,
        refKey: "debt",
      });
      const withDebt = await snapshot(db, workspaceId);

      expect(await remove()).toEqual({ ok: false, error: "balance_negative" });

      expect(await snapshot(db, workspaceId)).toEqual(withDebt);
      expect(withDebt).not.toEqual(before);
      await createBillingJournalRepository(db, workspaceId).append({
        type: "correction",
        amountMicroUsd: 3,
        refKey: "debt-settled",
      });
      expect(await remove()).toEqual({ ok: true });
    });

    it("waits while a review is running", async () => {
      const { db, a, remove } = await start();
      await db
        .updateTable("jobs")
        .set({ status: "running" })
        .where("id", "=", a.queuedJobId)
        .execute();
      expect(await remove()).toEqual({ ok: false, error: "review_running" });
      await db
        .updateTable("jobs")
        .set({ status: "queued" })
        .where("id", "=", a.queuedJobId)
        .execute();

      expect(await remove()).toEqual({ ok: true });
    });

    // #658-T04
    it("waits while a superseded run still drains under its lease, and not after the lease has run out", async () => {
      const { db, a, remove } = await start();
      const supersede = (leaseExpiresAt: string | null) =>
        db
          .updateTable("jobs")
          .set({ status: "superseded", lease_expires_at: leaseExpiresAt })
          .where("id", "=", a.queuedJobId)
          .execute();

      await supersede(new Date(NOW.getTime() + 60_000).toISOString());
      expect(await remove()).toEqual({ ok: false, error: "review_running" });

      await supersede(new Date(NOW.getTime() - 60_000).toISOString());
      expect(await remove()).toEqual({ ok: true });
    });

    // #658-T04
    it("waits while a top-up checkout may still be paid, whether it is pending or expired, for as long as a late payment is credited", async () => {
      const { db, workspaceId, remove } = await start();
      const intents = createBillingTopUpIntentsRepository(
        db,
        workspaceId,
        () => NOW,
      );
      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 10_000_000,
      });
      const setIntent = (state: string, createdAt: string) =>
        db
          .updateTable("billing_topup_intents")
          .set({ state, created_at: createdAt })
          .where("id", "=", intent.id)
          .execute();
      const daysAgo = (days: number) =>
        new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

      await setIntent("pending", NOW.toISOString());
      expect(await remove()).toEqual({ ok: false, error: "payment_open" });
      // A delayed payment method can succeed days after the checkout began: the checkout page expiring ends nothing.
      await setIntent("pending", daysAgo(2));
      expect(await remove()).toEqual({ ok: false, error: "payment_open" });
      await setIntent("expired", daysAgo(2));
      expect(await remove()).toEqual({ ok: false, error: "payment_open" });
      // It ends when the provider says so (a payment or a refusal), or when the window in which a late payment is
      // still credited has passed (PENDING_TOP_UP_WINDOW_MS: the provider redelivers for three days).
      await setIntent("failed", NOW.toISOString());
      expect(await remove()).toEqual({ ok: true });
    });

    // #658-T04
    it("does not wait for a checkout that began after the window a late payment is credited in", async () => {
      const { db, workspaceId, remove } = await start();
      const intent = await createBillingTopUpIntentsRepository(
        db,
        workspaceId,
        () => NOW,
      ).create({ adapter: "fake", amountMicroUsd: 10_000_000 });
      await db
        .updateTable("billing_topup_intents")
        .set({
          state: "expired",
          created_at: new Date(
            NOW.getTime() - PENDING_TOP_UP_WINDOW_MS - 1000,
          ).toISOString(),
        })
        .where("id", "=", intent.id)
        .execute();

      expect(await remove()).toEqual({ ok: true });
    });

    // #658-T03
    it("keeps the provider's customer reference and erases the legal name, address and VAT id of the billing profile", async () => {
      const { db, workspaceId, remove } = await start();

      expect(await remove()).toEqual({ ok: true });

      const profile = await db
        .selectFrom("billing_profiles")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      expect(profile).toMatchObject({
        legal_name: "",
        country: "",
        address_line1: "",
        address_line2: null,
        postal_code: "",
        city: "",
        vat_id: null,
        confirmed_by: null,
        customer_adapter: "fake",
        customer_ref: "cus_a",
        terms_version: "2026-10",
      });
      const text = JSON.stringify(profile);
      for (const marker of [
        "Legal a GmbH",
        "Street a",
        "DE123456789",
        "Floor a",
      ])
        expect(text).not.toContain(marker);
    });

    // #658-T03
    it("removes a billing profile that never reached the provider altogether", async () => {
      const { db, workspaceId, remove } = await start();
      await db
        .updateTable("billing_profiles")
        .set({ customer_adapter: null, customer_ref: null })
        .where("workspace_id", "=", workspaceId)
        .execute();

      expect(await remove()).toEqual({ ok: true });

      expect(
        await db
          .selectFrom("billing_profiles")
          .select("workspace_id")
          .where("workspace_id", "=", workspaceId)
          .execute(),
      ).toEqual([]);
    });

    // #658-T03
    it("notes an installation the person had disconnected as unclaimed too", async () => {
      const { db, workspaceId, remove } = await start();
      const integrations = createIntegrationsRepository(db, workspaceId);
      const disconnected = await integrations.create({
        type: "github_app",
        displayName: "acme-old",
        externalId: "installation-old",
        config: { accountLogin: "acme-old", accountType: "User" },
      });
      await integrations.setStatus(disconnected.id, "disconnected");

      expect(await remove()).toEqual({ ok: true });

      expect(await integrations.list()).toEqual([]);
      expect(
        await createUnclaimedInstallationsRepository(db).get(
          "installation-old",
        ),
      ).toMatchObject({ accountLogin: "acme-old", accountType: "User" });
    });

    it("cannot be repeated: a deleted workspace has no Owner any more", async () => {
      const { remove } = await start();
      expect(await remove()).toEqual({ ok: true });
      expect(await remove()).toEqual({ ok: false, error: "not_found" });
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
