// SPDX-License-Identifier: Apache-2.0

// An operator's manual credit against the deletion of the workspace, on Postgres with several connections (#658). The service reads
// the workspace `FOR SHARE` inside the transaction that writes the entry, the deletion takes the row `FOR UPDATE`; a plain read
// outside the transaction credited a workspace that a deletion had just removed (the deletion held the balance row, the credit
// waited for it and was then written onto the tombstone).
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
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
import { createWorkspaceDeletion } from "../workspaces/delete-workspace.ts";
import {
  createManualCreditService,
  ManualCreditError,
} from "./manual-credit.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const USD = 1_000_000;

async function start() {
  const postgres = await createPostgresTestDatabase({ poolMax: 4 });
  const workspaceId = await defaultWorkspaceId(postgres.db);
  const seeded = await seedWorkspaceForDeletion(postgres.db, workspaceId, "a", {
    balanceMicroUsd: 0,
  });
  const holder = connectPostgres(withApplicationName(postgres.url, "cr_hold"));
  const operator = connectPostgres(
    withApplicationName(postgres.url, "cr_operator"),
  );
  const deleter = connectPostgres(
    withApplicationName(postgres.url, "cr_delete"),
  );
  const remove = () =>
    createWorkspaceDeletion({ db: deleter.db, log: () => undefined }).delete({
      workspaceId,
      actorId: "owner-a",
      confirmName: "Default workspace",
    });
  const grant = () =>
    createManualCreditService(operator.db, {
      logger: { info: () => undefined },
    })
      .grant({
        workspaceId,
        amount: 10 * USD,
        actor: "operator-1",
        note: "goodwill",
      })
      .then(
        (entry) => entry,
        (error: unknown) => error,
      );
  /** Holds a transaction of the holder open after `work`, until `release()`. */
  function hold(work: (trx: typeof holder.db) => Promise<void>) {
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
    });
    return { done, release, transaction };
  }
  const entryCount = async () =>
    Number(
      (
        await postgres.db
          .selectFrom("billing_journal_entries")
          .select((builder) => builder.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .executeTakeFirstOrThrow()
      ).count,
    );
  return { postgres, workspaceId, seeded, remove, grant, hold, entryCount };
}

describePostgres(
  "a manual credit against the deletion of its workspace",
  () => {
    // #658-T04
    it("refuses a credit that arrives while the deletion is in flight, and writes no entry", async () => {
      const t = await start();
      const before = await t.entryCount();
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
      const release = (error: unknown) => {
        blocker.release();
        throw error;
      };
      await waitForLockWait(t.postgres.db, "cr_delete").catch(release);
      const grant = t.grant();
      await waitForLockWait(t.postgres.db, "cr_operator").catch(release);
      blocker.release();
      await blocker.transaction;

      expect(await deletion).toEqual({ ok: true });
      const outcome = await grant;
      expect(outcome).toBeInstanceOf(ManualCreditError);
      expect((outcome as ManualCreditError).code).toBe("workspace_not_found");
      expect(await t.entryCount()).toBe(before);
    });

    // #658-T04
    it("makes the deletion wait for a credit that is being written, and then refuse with balance_positive", async () => {
      const t = await start();
      // The balance row is held, so the credit has read the workspace and waits to write.
      const balance = t.hold(async (trx) => {
        await createBillingJournalRepository(trx, t.workspaceId).lockBalance();
      });
      await balance.done;
      const grant = t.grant();
      const release = (error: unknown) => {
        balance.release();
        throw error;
      };
      await waitForLockWait(t.postgres.db, "cr_operator").catch(release);
      let settled = false;
      const deletion = t.remove().then((result) => {
        settled = true;
        return result;
      });
      await waitForLockWait(t.postgres.db, "cr_delete").catch(release);
      expect(settled).toBe(false);
      balance.release();
      await balance.transaction;

      expect(await grant).toMatchObject({ type: "top_up" });
      expect(await deletion).toEqual({ ok: false, error: "balance_positive" });
    });
  },
);
