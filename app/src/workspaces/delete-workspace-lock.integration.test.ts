// SPDX-License-Identifier: LicenseRef-Proprietary

// Deleting a workspace against a claim that is in flight, on Postgres with two connections (#658): a claim sets the job
// `running` and its transaction has not committed yet, so no other connection can see that. The deletion must wait for it and
// then refuse (`review_running`), never delete a job a runner holds.
import { describe, expect, it } from "vitest";
import { lockDynamicReviewGate } from "../db/dynamic-review-lock.ts";
import { createRunnerJobsRepository } from "../db/repositories/runner-jobs-repository.ts";
import {
  waitForLockWait,
  withApplicationName,
} from "../test-support/postgres-lock-wait.ts";
import {
  seedWorkspaceForDeletion,
  type SeededWorkspace,
} from "../test-support/workspace-deletion-fixture.ts";
import { defaultWorkspaceId } from "../test-support/workspaces.ts";
import { createWorkspaceDeletion } from "./delete-workspace.ts";
import {
  connectPostgres,
  createTestDatabase,
} from "../test-support/test-database.ts";

async function start() {
  const postgres = await createTestDatabase({ poolMax: 4 });
  const workspaceId = await defaultWorkspaceId(postgres.db);
  const seeded: SeededWorkspace = await seedWorkspaceForDeletion(
    postgres.db,
    workspaceId,
    "a",
    { balanceMicroUsd: 0 },
  );
  const claimer = connectPostgres(
    withApplicationName(postgres.url, "cr_claim"),
  );
  const deleter = connectPostgres(
    withApplicationName(postgres.url, "cr_delete"),
  );
  const deletion = createWorkspaceDeletion({
    db: deleter.db,
    log: () => undefined,
  });
  const remove = () =>
    deletion.delete({
      workspaceId,
      actorId: "owner-a",
      confirmName: "Default workspace",
    });
  /** Holds a transaction of the claimer open after `work`, until `release()`. */
  function hold<T>(work: (trx: typeof claimer.db) => Promise<T>) {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: (value: T) => void = () => undefined;
    const done = new Promise<T>((resolve) => {
      ready = resolve;
    });
    const transaction = claimer.db.transaction().execute(async (trx) => {
      ready(await work(trx));
      await open;
    });
    return { done, release, transaction };
  }
  return { postgres, workspaceId, seeded, claimer, remove, hold };
}

describe("deleting a workspace while a claim is in flight", () => {
  // #658-T04
  it("waits for a claim whose transaction has not committed and then refuses, leaving the running job alone", async () => {
    const t = await start();
    const claim = t.hold((trx) =>
      createRunnerJobsRepository(trx).claimNext("runner-1"),
    );
    expect((await claim.done)?.job.id).toBe(t.seeded.queuedJobId);

    let settled = false;
    const deletion = t.remove().then((result) => {
      settled = true;
      return result;
    });
    await waitForLockWait(t.postgres.db, "cr_delete");
    expect(settled).toBe(false);
    claim.release();
    await claim.transaction;

    expect(await deletion).toEqual({ ok: false, error: "review_running" });
    expect(
      await t.postgres.db
        .selectFrom("jobs")
        .select(["id", "status"])
        .where("id", "=", t.seeded.queuedJobId)
        .execute(),
    ).toEqual([{ id: t.seeded.queuedJobId, status: "running" }]);
  });

  // #658-T04
  it("waits for the row of a job that is being set running by a writer that takes no other lock, and then refuses", async () => {
    const t = await start();
    const writer = t.hold(async (trx) => {
      await trx
        .updateTable("jobs")
        .set({ status: "running" })
        .where("id", "=", t.seeded.queuedJobId)
        .execute();
    });
    await writer.done;

    let settled = false;
    const deletion = t.remove().then((result) => {
      settled = true;
      return result;
    });
    await waitForLockWait(t.postgres.db, "cr_delete");
    expect(settled).toBe(false);
    writer.release();
    await writer.transaction;

    expect(await deletion).toEqual({ ok: false, error: "review_running" });
    expect(
      (
        await t.postgres.db
          .selectFrom("jobs")
          .select("status")
          .where("id", "=", t.seeded.queuedJobId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("running");
  });

  // #658-T04
  it("takes the Dynamic gate first, which every runner transition holds exclusively, so a claim cannot wait for the rows this deletion holds", async () => {
    const t = await start();
    const runner = t.hold((trx) => lockDynamicReviewGate(trx, true));
    await runner.done;

    let settled = false;
    const deletion = t.remove().then((result) => {
      settled = true;
      return result;
    });
    await waitForLockWait(t.postgres.db, "cr_delete");
    expect(settled).toBe(false);
    runner.release();
    await runner.transaction;

    expect(await deletion).toEqual({ ok: true });
  });

  // #658-T04
  it("deletes once the claim has rolled back, and a claim that starts afterwards finds no job", async () => {
    const t = await start();
    const claim = t.hold(async (trx) => {
      await createRunnerJobsRepository(trx).claimNext("runner-1");
      throw new Error("the claim is abandoned");
    });
    await claim.transaction.catch(() => undefined);

    expect(await t.remove()).toEqual({ ok: true });

    expect(
      await createRunnerJobsRepository(t.claimer.db).claimNext("runner-2"),
    ).toBeNull();
  });
});
