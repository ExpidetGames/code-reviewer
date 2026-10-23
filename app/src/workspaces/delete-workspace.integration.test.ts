// SPDX-License-Identifier: Apache-2.0

// Deleting a workspace (#658), against a real database on SQLite and, with TEST_DATABASE_URL, on Postgres: the typed name
// and the Owner role are needed, a positive balance refuses, everything of the workspace goes (checked over every table
// that has a `workspace_id`, so a table added later cannot be forgotten), the money history stays, and a second workspace
// is not touched by a single row.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createInstallationLinkRequestsRepository } from "../db/repositories/installation-link-requests-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createInvitationsRepository } from "../db/repositories/invitations-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createUnclaimedInstallationsRepository } from "../db/repositories/unclaimed-installations-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { createWorkspaceSecretsRepository } from "../db/repositories/workspace-secrets-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
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

const SHA = "b".repeat(40);
const NOW = new Date("2026-10-23T12:00:00.000Z");

async function addUser(db: Kysely<Database>, id: string) {
  await db
    .insertInto("users")
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      email_verified: 1,
      image: null,
      github_login: null,
      imported_at: null,
      is_instance_admin: 0,
      org_checked_at: null,
      org_checked_for: null,
      created_at: "2026-10-12T00:00:00.000Z",
      updated_at: "2026-10-12T00:00:00.000Z",
    })
    .execute();
}

/**
 * A workspace as a customer leaves it: an Owner and an Admin, an installation with a repository and a project, a queued
 * job with its usage record and check run, settings, a stored key, an invitation, a billing profile, and a journal whose
 * balance is `balance` (0 by spending the top-up on a job that finished).
 */
async function seed(
  db: Kysely<Database>,
  workspaceId: string,
  tag: string,
  options: { balanceMicroUsd: number },
) {
  await addUser(db, `owner-${tag}`);
  await addUser(db, `admin-${tag}`);
  const members = createWorkspaceMembersRepository(db, workspaceId);
  await members.add(`owner-${tag}`, "owner");
  await members.add(`admin-${tag}`, "admin");
  const integrations = createIntegrationsRepository(db, workspaceId);
  const integration = await integrations.create({
    type: "github_app",
    displayName: `acme-${tag}`,
    externalId: `installation-${tag}`,
    config: { accountLogin: `acme-${tag}`, accountType: "Organization" },
  });
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: `repo-${tag}`,
      fullName: `acme/${tag}`,
      url: `https://github.test/acme/${tag}`,
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  await createProjectsRepository(db, workspaceId).activate(repository.id);
  const jobs = createJobsRepository(db, workspaceId);
  const enqueue = async (prNumber: number, deliveryId: string) => {
    const enqueued = await jobs.enqueue({
      repositoryId: repository.id,
      prNumber,
      prUrl: `https://github.test/acme/${tag}/pull/${prNumber}`,
      headSha: SHA,
      reviewKind: "diff",
      command: "review",
      args: "",
      triggerKind: "webhook",
      actorLogin: "octocat",
      deliveryId,
      commentId: "comment-" + deliveryId,
      runAfter: null,
    });
    if (enqueued.status !== "created") throw new Error("seeding failed");
    return enqueued.job;
  };
  const queued = await enqueue(7, `delivery-${tag}`);
  const finished = await enqueue(8, `delivery-finished-${tag}`);
  const usage = createUsageRecordsRepository(db, workspaceId);
  await usage.reserve(queued.id, "own");
  await db
    .insertInto("job_vm_runs")
    .values({
      job_id: finished.id,
      vm_name: `vm-${tag}`,
      workspace_id: workspaceId,
      attempt: 1,
      claimed_at: "2026-10-10T23:50:00.000Z",
      started_at: "2026-10-10T23:51:00.000Z",
      reported_at: "2026-10-10T23:51:01.000Z",
      vm_timeout_seconds: 2100,
      billable: 1,
      created_at: "2026-10-10T23:51:01.000Z",
      updated_at: "2026-10-10T23:51:01.000Z",
    })
    .execute();
  await db
    .insertInto("job_dispatches")
    .values({
      job_id: queued.id,
      state: "pending",
      attempts: 0,
      consecutive_failures: 0,
      next_dispatch_at: "2026-10-23T12:00:00.000Z",
      acked_at: null,
      last_attempt_at: null,
      last_status: null,
      last_code: null,
      created_at: "2026-10-23T12:00:00.000Z",
      updated_at: "2026-10-23T12:00:00.000Z",
    })
    .execute();
  await db
    .insertInto("job_check_runs")
    .values({
      job_id: queued.id,
      workspace_id: workspaceId,
      next_attempt_at: "2026-10-23T12:00:00.000Z",
      created_at: "2026-10-23T12:00:00.000Z",
      updated_at: "2026-10-23T12:00:00.000Z",
    })
    .execute();
  await createAppSettingsRepository(db, workspaceId).set(
    "review_defaults",
    { from: tag },
    tag,
  );
  await createWorkspaceSecretsRepository(db, workspaceId).put({
    name: "llm_api_key",
    binding: `binding-${tag}`,
    ciphertext: `ciphertext-${tag}`,
    nonce: `nonce-${tag}`,
    keyVersion: 1,
    lastFour: null,
    updatedBy: `owner-${tag}`,
  });
  await createWorkspaceEntitlementsRepository(db, workspaceId).put(
    {
      planLabel: `plan-${tag}`,
      keyMode: "managed",
      limits: {
        diffRunsPerPeriod: 10,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: 1000,
        ownKeyCostLimitMicroUsd: null,
      },
      periodStart: "2026-10-01T00:00:00.000Z",
      suspended: false,
      suspensionCode: null,
    },
    `owner-${tag}`,
  );
  await createInvitationsRepository(db, workspaceId).create({
    id: `invitation-${tag}`,
    email: `invited-${tag}@example.test`,
    role: "member",
    invitedBy: `owner-${tag}`,
    tokenHash: `hash-${tag}`,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  await createInstallationLinkRequestsRepository(db, workspaceId).createPending(
    {
      requestedBy: `owner-${tag}`,
      requesterGithubLogin: `login-${tag}`,
      installationId: `requested-${tag}`,
      accountLogin: `acme-${tag}`,
      accountType: "Organization",
      accountId: `account-${tag}`,
      evidence: {
        tokenCanAccess: true,
        roleResult: "unreadable",
        roleDetail: "forbidden",
      },
    },
  );
  const profiles = createBillingProfilesRepository(db, workspaceId);
  await profiles.save({
    legalName: `Legal ${tag} GmbH`,
    country: "DE",
    addressLine1: `Street ${tag}`,
    addressLine2: null,
    postalCode: "10115",
    city: "Berlin",
    vatId: null,
  });
  await createBillingNotificationsRepository(db, workspaceId).markSent(
    "empty",
    "due",
  );
  const intents = createBillingTopUpIntentsRepository(db, workspaceId);
  const paid = await intents.create({
    adapter: "fake",
    amountMicroUsd: 25_000_000,
  });
  await intents.attachRefs(paid.id, {
    checkoutRef: `cs-${tag}`,
    paymentRef: `pi-${tag}`,
  });
  // Paid long ago: an intent that is still pending would be an open payment.
  await db
    .updateTable("billing_topup_intents")
    .set({ state: "paid", created_at: "2026-09-01T00:00:00.000Z" })
    .where("id", "=", paid.id)
    .execute();
  const journal = createBillingJournalRepository(db, workspaceId);
  await journal.append({
    type: "top_up",
    amountMicroUsd: 5_000_000,
    refKey: `pi-${tag}`,
  });
  const spent = 5_000_000 - options.balanceMicroUsd;
  if (spent > 0)
    await journal.charge(finished.id, {
      aiMicroUsd: spent,
      infraMicroUsd: 0,
      minutes: 1,
      reviewKind: "diff",
    });
  return { workspaceId, tag, queuedJobId: queued.id, integration };
}

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
  describe.skipIf(engine.skip)(`deleting a workspace on ${engine.name}`, () => {
    async function start(
      options: { balanceMicroUsd?: number; otherBalanceMicroUsd?: number } = {},
    ) {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      const a = await seed(db, workspaceId, "a", {
        balanceMicroUsd: options.balanceMicroUsd ?? 0,
      });
      const b = await seed(db, otherWorkspaceId, "b", {
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
    it("is allowed at a balance of zero and below it (the journal keeps the debt)", async () => {
      const { db, workspaceId, remove } = await start();
      await createBillingJournalRepository(db, workspaceId).append({
        type: "correction",
        amountMicroUsd: -3,
        refKey: "debt",
      });

      expect(await remove()).toEqual({ ok: true });
    });

    it("waits while a review is running, and while a top-up checkout may still be paid", async () => {
      const { db, a, workspaceId, remove } = await start();
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

      await createBillingTopUpIntentsRepository(
        db,
        workspaceId,
        () => NOW,
      ).create({ adapter: "fake", amountMicroUsd: 10_000_000 });
      expect(await remove()).toEqual({ ok: false, error: "payment_open" });

      // A checkout that began days ago has ended at the provider.
      await db
        .updateTable("billing_topup_intents")
        .set({ created_at: "2026-10-01T00:00:00.000Z" })
        .where("workspace_id", "=", workspaceId)
        .execute();
      expect(await remove()).toEqual({ ok: true });
    });

    it("cannot be repeated: a deleted workspace has no Owner any more", async () => {
      const { remove } = await start();
      expect(await remove()).toEqual({ ok: true });
      expect(await remove()).toEqual({ ok: false, error: "not_found" });
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
