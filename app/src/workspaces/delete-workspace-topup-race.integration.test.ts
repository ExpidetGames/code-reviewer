// SPDX-License-Identifier: LicenseRef-Proprietary

// A payment against a deletion, on Postgres with several connections (#658). The top-up reads its workspace `FOR SHARE`
// (`getIncludingDeleted(id, { lock: true })`, called by `applyBillingEvent`) and the deletion takes the same row `FOR UPDATE`
// (`WorkspaceMembers.lock`), so the two cannot overlap. Without that lock both orders lose money, because a plain read sees the
// workspace as it was before the other transaction committed:
// - the deletion is in flight (it holds the workspace and balance rows, and has not committed): a top-up that reads the workspace
//   sees it alive, waits for the balance row, and credits a workspace that is gone by the time it gets it;
// - the top-up is in flight (it has read the workspace alive, and not credited yet): the deletion does not wait for it, commits
//   first, and the credit lands on the tombstone.
// With the lock the first top-up answers `workspace_deleted` and the second makes the deletion refuse with `balance_positive`.
import { describe, expect, it } from "vitest";
import { applyBillingEvent } from "../billing/apply-event.ts";
import { toUsd, type BillingEvent } from "../billing/adapter.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import {
  waitForLockWait,
  withApplicationName,
} from "../test-support/postgres-lock-wait.ts";
import { seedWorkspaceForDeletion } from "../test-support/workspace-deletion-fixture.ts";
import { defaultWorkspaceId } from "../test-support/workspaces.ts";
import { createWorkspaceDeletion } from "./delete-workspace.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const USD = 1_000_000;
const PAYMENT = "pi_late";

async function start() {
  const postgres = await createPostgresTestDatabase({ poolMax: 4 });
  const workspaceId = await defaultWorkspaceId(postgres.db);
  const seeded = await seedWorkspaceForDeletion(postgres.db, workspaceId, "a", {
    balanceMicroUsd: 0,
  });
  // A top-up that was started long ago and is paid now (a delayed payment method): the window in which a deletion refuses with
  // `payment_open` is over, so only the lock stands between the payment and the deletion.
  const intent = await createBillingTopUpIntentsRepository(
    postgres.db,
    workspaceId,
  ).create({ adapter: "fake", amountMicroUsd: 25 * USD });
  await postgres.db
    .updateTable("billing_topup_intents")
    .set({ created_at: "2026-09-01T00:00:00.000Z" })
    .where("id", "=", intent.id)
    .execute();
  const event: BillingEvent = {
    type: "payment.succeeded",
    eventId: "evt_late",
    occurredAt: "2026-10-23T12:00:00.000Z",
    intentId: intent.id,
    payment: PAYMENT,
    checkout: "cs_late",
    creditable: toUsd(25 * USD),
    gross: toUsd(29_750_000),
    tax: toUsd(4_750_000),
  };
  const holder = connectPostgres(withApplicationName(postgres.url, "cr_hold"));
  const topper = connectPostgres(withApplicationName(postgres.url, "cr_topup"));
  const deleter = connectPostgres(
    withApplicationName(postgres.url, "cr_delete"),
  );
  const remove = () =>
    createWorkspaceDeletion({ db: deleter.db, log: () => undefined }).delete({
      workspaceId,
      actorId: "owner-a",
      confirmName: "Default workspace",
    });
  const topUp = () => applyBillingEvent(topper.db, { provider: "fake", event });
  /** Runs `work` on the holder's connection in a transaction that stays open until `release()`, then `after`. */
  function hold(
    work: (trx: typeof holder.db) => Promise<void>,
    after: (trx: typeof holder.db) => Promise<void> = async () => undefined,
  ) {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const transaction = holder.db.transaction().execute(async (trx) => {
      await work(trx);
      ready();
      await open;
      await after(trx);
    });
    return { done, release, transaction };
  }
  const entries = async () =>
    (
      await postgres.db
        .selectFrom("billing_journal_entries")
        .select(["type", "amount_micro_usd"])
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at")
        .orderBy("id")
        .execute()
    ).map((entry) => ({
      type: entry.type,
      amount_micro_usd: Number(entry.amount_micro_usd),
    }));
  return { postgres, workspaceId, seeded, remove, topUp, hold, entries };
}

describePostgres("a payment against the deletion of its workspace", () => {
  // #658-T04
  it("answers a late top-up with workspace_deleted while the deletion is in flight, and credits nothing", async () => {
    const t = await start();
    // The deletion stops at the first row it removes (the dispatch of the waiting job), after it took the workspace and balance rows.
    const blocker = t.hold(async (trx) => {
      await trx
        .selectFrom("job_dispatches")
        .select("job_id")
        .where("job_id", "=", t.seeded.queuedJobId)
        .forUpdate()
        .execute();
    });
    await blocker.done;
    const deletion = t.remove();
    // A failing assertion must not leave the holder's transaction open until the hook times out.
    const releaseAtEnd = () => blocker.release();
    await waitForLockWait(t.postgres.db, "cr_delete").catch((error) => {
      releaseAtEnd();
      throw error;
    });

    let settled = false;
    const topUp = t.topUp().then((result) => {
      settled = true;
      return result;
    });
    await waitForLockWait(t.postgres.db, "cr_topup").catch((error) => {
      releaseAtEnd();
      throw error;
    });
    expect(settled).toBe(false);
    blocker.release();
    await blocker.transaction;

    expect(await deletion).toEqual({ ok: true });
    expect(await topUp).toMatchObject({
      outcome: "workspace_deleted",
      needsReview: true,
    });
    expect(await t.entries()).toEqual([
      { type: "top_up", amount_micro_usd: 5 * USD },
      { type: "usage", amount_micro_usd: -5 * USD },
    ]);
    expect(
      (
        await createBillingJournalRepository(
          t.postgres.db,
          t.workspaceId,
        ).balance()
      ).balanceMicroUsd,
    ).toBe(0);
  });

  // #658-T04
  it("makes the deletion wait for a top-up that read the workspace alive, and then refuse with balance_positive", async () => {
    const t = await start();
    // What `applyBillingEvent` does first, then (after the release) what it does to the journal, on one transaction.
    const inFlight = t.hold(
      async (trx) => {
        const workspace = await createWorkspacesRepository(
          trx,
        ).getIncludingDeleted(t.workspaceId, { lock: true });
        expect(workspace?.deletedAt ?? null).toBeNull();
      },
      async (trx) => {
        await createBillingJournalRepository(trx, t.workspaceId).append({
          type: "top_up",
          amountMicroUsd: 25 * USD,
          refKey: PAYMENT,
          provider: "fake",
          providerRef: PAYMENT,
        });
      },
    );
    await inFlight.done;

    let settled = false;
    const deletion = t.remove().then((result) => {
      settled = true;
      return result;
    });
    await waitForLockWait(t.postgres.db, "cr_delete").catch((error) => {
      inFlight.release();
      throw error;
    });
    expect(settled).toBe(false);
    inFlight.release();
    await inFlight.transaction;

    expect(await deletion).toEqual({ ok: false, error: "balance_positive" });
    expect(await t.entries()).toEqual([
      { type: "top_up", amount_micro_usd: 5 * USD },
      { type: "usage", amount_micro_usd: -5 * USD },
      { type: "top_up", amount_micro_usd: 25 * USD },
    ]);
    expect(
      (
        await t.postgres.db
          .selectFrom("workspaces")
          .select(["name", "deleted_at"])
          .where("id", "=", t.workspaceId)
          .executeTakeFirstOrThrow()
      ).deleted_at,
    ).toBeNull();
  });
});
