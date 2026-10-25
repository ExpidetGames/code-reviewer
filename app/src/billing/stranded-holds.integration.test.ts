// SPDX-License-Identifier: LicenseRef-Proprietary

// The holds of jobs that ended while billing was off (#591; ADR 0006, 2.6; follow-up of #498). A job that took its hold
// while billing was on and ended after the switch was turned off keeps its `reservation` with no `release`: nothing runs
// while billing is off. The decision (the maintainer confirms it on #591): such a run is RELEASED, never charged; billing off
// means no charge. The reconciliation runs when billing is switched on (inside the transaction that writes `enabled`) and as a
// step of the sweep while billing is on, and `verify()` flags what is left.
//
// #605: no claim takes a hold any more, so this machinery is dormant: it acts on the reservations an earlier release wrote and
// on nothing a new job leaves. The tests keep pinning it for those rows; `claim` writes such a reservation by hand after the
// claim (what the claim of an earlier release did), and one test shows that a job claimed since #605 leaves nothing to release.
import { sql, type KyselyPlugin } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import {
  findStrandedHolds,
  suspectWorkspacesQuery,
} from "../db/repositories/billing-holds-sweep.ts";
import type { JobOutcome } from "../jobs/job-types.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createSecretStore } from "../secrets/store.ts";
import { afterQueryPlugin, describeQuery } from "../test-support/query-hook.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  sha,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import { SETUP_TEST_SECRET } from "../test-support/setup-harness.ts";
import { insertUser } from "../test-support/users.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createBillingAdminService } from "./admin-service.ts";
import { settleEndedJobs } from "./settle-jobs.ts";
import {
  releaseStrandedHolds,
  releaseStrandedHoldsWhileBillingOn,
} from "./stranded-holds.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const ENGINES = ["pr-agent", "opencode"] as const;
const SECOND = 1000;
const FUNDING = 100_000_000;
/** The hold of a Diff job on the workspace's own key: 25 minutes x 13,000 (hold.test.ts). */
const OWN_KEY_DIFF_HOLD = 325_000;
/** The same on the operator's key: 25 minutes x 13,000 and 150,000 x 5.0 for the AI. */
const MANAGED_DIFF_HOLD = 1_075_000;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

const delivered: JobOutcome = {
  ok: true,
  result: {
    ok: true,
    usage: {
      promptTokens: 100,
      completionTokens: 10,
      costUsd: 0.5,
      aiCalls: 1,
    },
  },
};

describe("the holds of ended jobs", () => {
  async function start(options: { funding?: number } = {}) {
    const database = await open();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
    });
    await setBillingSwitch(fixture.db, true);
    await fundWorkspace(
      fixture.db,
      fixture.workspaceId,
      options.funding ?? FUNDING,
    );
    return fixture;
  }

  const journalOf = (fixture: JobQueueFixture) =>
    createBillingJournalRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );

  let pr = 100;
  async function claim(fixture: JobQueueFixture) {
    pr += 1;
    fixture.clock.advance(1);
    const job = await fixture.enqueueNew({ prNumber: pr });
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    if (claimed === null || claimed.job.id !== job.id)
      throw new Error("The job was not claimed.");
    // The hold an earlier release took at the claim.
    await journalOf(fixture).reserve(OWN_KEY_DIFF_HOLD, job.id);
    return { job: claimed.job, leaseToken: claimed.leaseToken };
  }

  /** A job that took its hold with billing on and ended with billing off, which is then switched on again. */
  async function endedWhileOff(fixture: JobQueueFixture) {
    const claimed = await claim(fixture);
    await setBillingSwitch(fixture.db, false);
    await fixture.queue.complete(claimed.job.id, claimed.leaseToken, delivered);
    return claimed.job;
  }

  async function entriesOf(fixture: JobQueueFixture, jobId: string) {
    const { entries } = await journalOf(fixture).entries({ limit: 200 });
    return entries.filter((entry) => entry.jobId === jobId).reverse();
  }
  const shape = (entries: JournalEntry[]) =>
    entries.map((entry) => [entry.type, entry.amountMicroUsd]);

  // #591-T01
  it("releases the hold of a job that ended while billing was off, charges nothing, and the balance equals the sum of the entries", async () => {
    const fixture = await start();
    const job = await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);
    // Before: the hold is still reserved, and the journal does not know.
    expect(await journalOf(fixture).balance()).toEqual({
      balanceMicroUsd: FUNDING - OWN_KEY_DIFF_HOLD,
      reservedMicroUsd: OWN_KEY_DIFF_HOLD,
    });

    const result = await releaseStrandedHolds(fixture.db, fixture.clock.now);

    expect(result).toEqual({ released: 1 });
    expect(shape(await entriesOf(fixture, job.id))).toEqual([
      ["reservation", -OWN_KEY_DIFF_HOLD],
      ["release", OWN_KEY_DIFF_HOLD],
    ]);
    expect(await journalOf(fixture).balance()).toEqual({
      balanceMicroUsd: FUNDING,
      reservedMicroUsd: 0,
    });
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
      strandedHoldCount: 0,
    });
  });

  // #591-T02
  it("flags a stranded hold in verify() until it is released", async () => {
    const fixture = await start();
    const job = await endedWhileOff(fixture);

    const flagged = await journalOf(fixture).verify();
    // The cache and the journal agree; the hold is what is wrong.
    expect(flagged).toMatchObject({
      differenceMicroUsd: 0,
      reservedDifferenceMicroUsd: 0,
      strandedHoldCount: 1,
      strandedHoldMicroUsd: OWN_KEY_DIFF_HOLD,
      consistent: false,
    });
    expect(await findStrandedHolds(fixture.db, 10)).toEqual([
      { workspaceId: fixture.workspaceId, jobId: job.id },
    ]);

    await setBillingSwitch(fixture.db, true);
    await releaseStrandedHolds(fixture.db, fixture.clock.now);

    expect(await journalOf(fixture).verify()).toMatchObject({
      strandedHoldCount: 0,
      strandedHoldMicroUsd: 0,
      consistent: true,
    });
    expect(await findStrandedHolds(fixture.db, 10)).toEqual([]);
  });

  // #591-T03
  it("is idempotent: a second run releases nothing and writes nothing", async () => {
    const fixture = await start();
    const job = await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);

    expect(await releaseStrandedHolds(fixture.db, fixture.clock.now)).toEqual({
      released: 1,
    });
    const after = await journalOf(fixture).entries({ limit: 200 });
    expect(await releaseStrandedHolds(fixture.db, fixture.clock.now)).toEqual({
      released: 0,
    });

    expect(await journalOf(fixture).entries({ limit: 200 })).toEqual(after);
    expect(await entriesOf(fixture, job.id)).toHaveLength(2);
  });

  // #591-T04
  it("leaves the hold of a running job, of a requeued job and of a settled job alone", async () => {
    const fixture = await start();
    const running = await claim(fixture);
    // A job that ended with billing on is settled in its own transaction.
    const settled = await claim(fixture);
    await fixture.queue.complete(settled.job.id, settled.leaseToken, delivered);
    // A job that was given back keeps its hold (a requeue never releases) and is not final.
    const requeued = await claim(fixture);
    await fixture.queue.release(
      requeued.job.id,
      requeued.leaseToken,
      "worker_exited",
    );
    const before = await journalOf(fixture).entries({ limit: 200 });

    expect(await releaseStrandedHolds(fixture.db, fixture.clock.now)).toEqual({
      released: 0,
    });

    expect(await journalOf(fixture).entries({ limit: 200 })).toEqual(before);
    expect(
      (await entriesOf(fixture, running.job.id)).map((e) => e.type),
    ).toEqual(["reservation"]);
    expect(
      (await entriesOf(fixture, settled.job.id)).map((e) => e.type),
    ).toEqual(["reservation", "release", "usage"]);
  });

  // #591-T05
  it("releases a job that ended while billing was off even when it carried a result, and never writes a usage", async () => {
    const fixture = await start();
    const job = await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);

    await releaseStrandedHolds(fixture.db, fixture.clock.now);

    const types = (await entriesOf(fixture, job.id)).map((e) => e.type);
    expect(types).not.toContain("usage");
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "succeeded",
    });
  });

  // #591-T06
  it("releases the holds of several workspaces and several jobs of one workspace", async () => {
    const fixture = await start();
    const first = await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);
    const second = await claim(fixture);
    await setBillingSwitch(fixture.db, false);
    await fixture.queue.complete(second.job.id, second.leaseToken, delivered);
    await setBillingSwitch(fixture.db, true);

    expect(await releaseStrandedHolds(fixture.db, fixture.clock.now)).toEqual({
      released: 2,
    });

    for (const job of [first, second.job])
      expect((await entriesOf(fixture, job.id)).map((e) => e.type)).toEqual([
        "reservation",
        "release",
      ]);
    expect((await journalOf(fixture).balance()).reservedMicroUsd).toBe(0);
  });

  // #591-T07
  it("does the work in batches of the limit it is given, and the next run takes the rest", async () => {
    const fixture = await start();
    await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);
    const second = await claim(fixture);
    await setBillingSwitch(fixture.db, false);
    await fixture.queue.complete(second.job.id, second.leaseToken, delivered);
    await setBillingSwitch(fixture.db, true);

    expect(
      await releaseStrandedHolds(fixture.db, fixture.clock.now, { limit: 1 }),
    ).toEqual({ released: 1 });
    expect(await findStrandedHolds(fixture.db, 10)).toHaveLength(1);
    expect(await releaseStrandedHolds(fixture.db, fixture.clock.now)).toEqual({
      released: 1,
    });
  });

  // #591-T08
  it("the sweep entry point does nothing while billing is off, and reads no billing table", async () => {
    const fixture = await start();
    await endedWhileOff(fixture);
    const tables: string[] = [];
    const spy: KyselyPlugin = {
      transformQuery({ node }) {
        const table = describeQuery(node).table;
        if (table !== undefined) tables.push(table);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };

    const result = await releaseStrandedHoldsWhileBillingOn(
      fixture.db.withPlugin(spy),
      fixture.clock.now,
    );

    expect(result).toEqual({ released: 0 });
    expect(tables.filter((table) => table.startsWith("billing_"))).toEqual([]);
    expect(await findStrandedHolds(fixture.db, 10)).toHaveLength(1);
  });

  // #591-T09
  it("the sweep entry point releases while billing is on", async () => {
    const fixture = await start();
    await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);

    expect(
      await releaseStrandedHoldsWhileBillingOn(fixture.db, fixture.clock.now),
    ).toEqual({ released: 1 });
    expect(await findStrandedHolds(fixture.db, 10)).toEqual([]);
  });

  // #591-T10
  it("switching billing on releases the stranded holds in the transaction that writes enabled", async () => {
    const fixture = await start();
    const adminId = await insertUser(fixture.db, { id: "admin-591" });
    const job = await endedWhileOff(fixture);
    const service = createBillingAdminService({
      db: fixture.db,
      secretsOn: (executor) =>
        createSecretStore({ db: executor, appSecret: SETUP_TEST_SECRET }),
      publicUrl: "https://reviews.example.test",
      clientFor: () => {
        throw new Error("no outbound call");
      },
      now: fixture.clock.now,
      log: () => undefined,
    });
    await service.saveRates(adminId, {
      factorA: 50_000,
      minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
      diffAiReserveMicroUsd: 150_000,
    });
    expect((await journalOf(fixture).verify()).strandedHoldCount).toBe(1);

    expect(await service.setEnabled(adminId, true)).toEqual({ ok: true });

    expect((await entriesOf(fixture, job.id)).map((e) => e.type)).toEqual([
      "reservation",
      "release",
    ]);
    expect(await journalOf(fixture).balance()).toEqual({
      balanceMicroUsd: FUNDING,
      reservedMicroUsd: 0,
    });
  });

  // #591-T11
  it("a switch-on that is refused releases nothing", async () => {
    const fixture = await start();
    const adminId = await insertUser(fixture.db, { id: "admin-591b" });
    await endedWhileOff(fixture);
    const service = createBillingAdminService({
      db: fixture.db,
      secretsOn: (executor) =>
        createSecretStore({ db: executor, appSecret: SETUP_TEST_SECRET }),
      publicUrl: "https://reviews.example.test",
      clientFor: () => {
        throw new Error("no outbound call");
      },
      now: fixture.clock.now,
      log: () => undefined,
    });
    // No rates are set (the helper wrote only the switch): the service refuses.
    await setBillingSwitch(fixture.db, false, null);

    const refused = await service.setEnabled(adminId, true);

    expect(refused).toMatchObject({ ok: false, error: "billing_not_ready" });
    expect(await findStrandedHolds(fixture.db, 10)).toHaveLength(1);
  });

  // #591-T12
  it("a release racing a settlement and another release leaves exactly one release, and either the release alone or the release and the charge, never a double", async () => {
    const fixture = await start();
    const job = await claim(fixture);
    fixture.clock.advance(90 * SECOND);
    // The job ended without a settlement (billing was off), then billing came back on.
    await setBillingSwitch(fixture.db, false);
    await fixture.queue.complete(job.job.id, job.leaseToken, delivered);
    await setBillingSwitch(fixture.db, true);

    await Promise.all([
      releaseStrandedHolds(fixture.db, fixture.clock.now),
      releaseStrandedHolds(fixture.db, fixture.clock.now),
      fixture.db
        .transaction()
        .execute((trx) =>
          settleEndedJobs(trx, [job.job.id], fixture.clock.now),
        ),
    ]);

    // Whoever got the lock first decided: the release alone (the sweep won) or the release and the one charge (the
    // settlement won). The staged tests (T24) force each order; here the two outcomes are the only ones there are.
    const entries = await entriesOf(fixture, job.job.id);
    const charged = entries.find((e) => e.type === "usage");
    expect(shape(entries)).toEqual(
      charged === undefined
        ? [
            ["reservation", -OWN_KEY_DIFF_HOLD],
            ["release", OWN_KEY_DIFF_HOLD],
          ]
        : [
            ["reservation", -OWN_KEY_DIFF_HOLD],
            ["release", OWN_KEY_DIFF_HOLD],
            ["usage", charged.amountMicroUsd],
          ],
    );
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
      balanceMicroUsd: FUNDING + (charged?.amountMicroUsd ?? 0),
      reservedMicroUsd: 0,
    });
  });

  // #591-T13 (the staged order of a release and a claim is T25)
  it("a release racing the claims of other jobs of the workspace never loses a hold or a release", async () => {
    const fixture = await start();
    const stranded = await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);
    const jobs = await Promise.all(
      [1, 2, 3].map((n) =>
        fixture.enqueueNew({ prNumber: 700 + n, headSha: sha(String(n)) }),
      ),
    );

    const [, ...claims] = await Promise.all([
      releaseStrandedHolds(fixture.db, fixture.clock.now),
      fixture.queue.claimNext("runner-a", ENGINES),
      fixture.queue.claimNext("runner-b", ENGINES),
      fixture.queue.claimNext("runner-c", ENGINES),
    ]);

    expect(claims.every((claimed) => claimed !== null)).toBe(true);
    expect((await entriesOf(fixture, stranded.id)).map((e) => e.type)).toEqual([
      "reservation",
      "release",
    ]);
    const verified = await journalOf(fixture).verify();
    expect(verified).toMatchObject({ consistent: true });
    // The three new jobs hold nothing (#605); the old hold is given back.
    expect(verified.reservedMicroUsd).toBe(0);
    expect(jobs).toHaveLength(3);
  });
  /**
   * A managed-key Diff job whose Worker takes part in the supersede protocol, running with a VM; a newer push replaces it, so
   * it is `superseded` while its Worker still drains, with billing ON (#397; settle-jobs.integration.test.ts, #498-T09).
   */
  async function drainingSuperseded(fixture: JobQueueFixture) {
    await createWorkspaceEntitlementsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).put(
      {
        planLabel: "plan",
        keyMode: "managed",
        periodStart: "2026-10-01T00:00:00.000Z",
        suspended: false,
        suspensionCode: null,
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      },
      null,
    );
    pr += 1;
    fixture.clock.advance(1);
    const enqueued = await fixture.enqueueNew({ prNumber: pr });
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES, {
      acceptsSupersede: true,
    });
    if (claimed === null || claimed.job.id !== enqueued.id)
      throw new Error("The job was not claimed.");
    const { job, leaseToken } = claimed;
    // The hold an earlier release took at the claim (what makes the run subject to the old machinery).
    await journalOf(fixture).reserve(MANAGED_DIFF_HOLD, job.id);
    await createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).setKeyMode(job.id, "managed");
    const vmRuns = createJobVmRunsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    expect(
      await vmRuns.recordStart({
        jobId: job.id,
        vmName: "vm-1",
        claimedAt: job.claimedAt ?? "",
        attempt: 1,
        startedAt: fixture.clock.now(),
        vmTimeoutSeconds: 1500,
      }),
    ).toBe("recorded");
    fixture.clock.advance(60 * SECOND);
    await fixture.queue.enqueue({
      repositoryId: job.repositoryId,
      prNumber: job.prNumber,
      prUrl: job.prUrl,
      headSha: sha("e"),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
    });
    fixture.clock.advance(30 * SECOND);
    await vmRuns.confirmStopped(job.id, ["vm-1"], fixture.clock.now());
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "superseded",
    });
    return { job, leaseToken };
  }

  // #591-T19
  it("leaves the hold of a superseded run that still drains alone, so its Worker's report is charged as without the sweep", async () => {
    const fixture = await start();
    const { job, leaseToken } = await drainingSuperseded(fixture);

    // The sweep runs between the push and the report, with billing on.
    expect(
      await releaseStrandedHoldsWhileBillingOn(fixture.db, fixture.clock.now),
    ).toEqual({ released: 0 });
    expect(await findStrandedHolds(fixture.db, 10)).toEqual([]);
    await fixture.queue.complete(job.id, leaseToken, delivered);

    // The same entries as a settlement without the sweep (settle-jobs #498-T09): released AND charged.
    expect(shape(await entriesOf(fixture, job.id))).toEqual([
      ["reservation", -MANAGED_DIFF_HOLD],
      ["release", MANAGED_DIFF_HOLD],
      ["usage", -2_526_000],
    ]);
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
      reservedMicroUsd: 0,
    });
  });

  // #591-T20
  it("leaves the hold of a superseded run whose Worker never reports alone, so the expiry charges it as without the sweep", async () => {
    const fixture = await start();
    const { job } = await drainingSuperseded(fixture);
    expect(
      await releaseStrandedHoldsWhileBillingOn(fixture.db, fixture.clock.now),
    ).toEqual({ released: 0 });
    // The drain window and the grace for a late report pass without a report.
    fixture.clock.advance(10 * 60 * SECOND);

    await fixture.queue.expireStaleJobs();

    // settle-jobs #498-T09: 120 seconds from the VM's start, 2 minutes, the AI cost unknown.
    expect(shape(await entriesOf(fixture, job.id))).toEqual([
      ["reservation", -MANAGED_DIFF_HOLD],
      ["release", MANAGED_DIFF_HOLD],
      ["usage", -26_000],
    ]);
  });

  // #591-T21
  it("verify() is consistent while a superseded run drains, and flags it when its settlement ended with billing off", async () => {
    const fixture = await start();
    const { job, leaseToken } = await drainingSuperseded(fixture);

    // A normal drain is not a stranded hold: the report is still to come.
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
      strandedHoldCount: 0,
      strandedHoldMicroUsd: 0,
      reservedMicroUsd: MANAGED_DIFF_HOLD,
    });

    // The report arrives with billing off: the record is settled, nothing releases the hold.
    await setBillingSwitch(fixture.db, false);
    await fixture.queue.complete(job.id, leaseToken, delivered);
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: false,
      strandedHoldCount: 1,
      strandedHoldMicroUsd: MANAGED_DIFF_HOLD,
    });
    await setBillingSwitch(fixture.db, true);
    expect(
      await releaseStrandedHoldsWhileBillingOn(fixture.db, fixture.clock.now),
    ).toEqual({ released: 1 });
    expect(shape(await entriesOf(fixture, job.id))).toEqual([
      ["reservation", -MANAGED_DIFF_HOLD],
      ["release", MANAGED_DIFF_HOLD],
    ]);
  });
  // #591-T23
  it("asks which workspaces have a stranded hold without a sequential scan of the journal, the jobs or the balances", async () => {
    const fixture = await start();
    await claim(fixture);
    await endedWhileOff(fixture);
    // With the sequential scan out of the way the planner uses an index wherever there is one, and a `Seq Scan` is left
    // only on a table that has no index for the read: the plan for any size of data, not for this one.
    const plan = await fixture.db.transaction().execute(async (trx) => {
      await sql`set local enable_seqscan = off`.execute(trx);
      const { rows } = await sql<
        Record<string, string>
      >`explain ${suspectWorkspacesQuery()}`.execute(trx);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).not.toContain("Seq Scan");
    expect(plan).toContain("billing_balances_reserved");
  });
  // The staged races need two connections that run in parallel, so the pool of these tests has more than one.

  /** True once another connection is blocked on a lock (or `done()` says the other side has finished without one). */
  async function untilBlockedOrDone(
    fixture: JobQueueFixture,
    done: () => boolean,
  ): Promise<"blocked" | "done"> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (done()) return "done";
      const { rows } = await sql<{
        n: string;
      }>`select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
        fixture.db,
      );
      if (Number(rows[0]?.n) > 0) return "blocked";
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The other connection neither blocked nor finished.");
  }

  /**
   * Releases the hold of `jobId` and, after the release has read the reservation and before it writes anything, starts `other`
   * on another connection. The release holds the lock of the workspace's balance row from its first statement, so `other`
   * (a settlement, a claim) must wait for it; when it does not wait (the lock is gone) it finishes first, which `before`
   * reports. The release then goes on, and `other` is awaited.
   */
  async function releaseWhile<T>(
    fixture: JobQueueFixture,
    jobId: string,
    other: () => Promise<T>,
  ) {
    let started: Promise<T> | undefined;
    let otherDone = false;
    let before: "blocked" | "done" | undefined;
    const plugin = afterQueryPlugin(async (query) => {
      if (started !== undefined) return;
      if (query.kind !== "select" || query.table !== "billing_journal_entries")
        return;
      started = other().finally(() => {
        otherDone = true;
      });
      before = await untilBlockedOrDone(fixture, () => otherDone);
    });
    const released = await createBillingJournalRepository(
      fixture.db.withPlugin(plugin),
      fixture.workspaceId,
      fixture.clock.now,
    ).release(jobId);
    if (started === undefined) throw new Error("The release read nothing.");
    return { released, before, other: await started };
  }

  // #591-T24
  it("a settlement that starts while a release is in flight waits for it, finds it and charges nothing", async () => {
    const fixture = await start();
    const claimed = await claim(fixture);
    fixture.clock.advance(90 * SECOND);
    await setBillingSwitch(fixture.db, false);
    await fixture.queue.complete(claimed.job.id, claimed.leaseToken, delivered);
    await setBillingSwitch(fixture.db, true);

    const staged = await releaseWhile(fixture, claimed.job.id, () =>
      fixture.db
        .transaction()
        .execute((trx) =>
          settleEndedJobs(trx, [claimed.job.id], fixture.clock.now),
        ),
    );

    // The settlement was blocked by the lock of the release, then found the release and priced nothing.
    expect(staged.before).toBe("blocked");
    expect(staged.released).toMatchObject({ ok: true, created: true });
    expect(shape(await entriesOf(fixture, claimed.job.id))).toEqual([
      ["reservation", -OWN_KEY_DIFF_HOLD],
      ["release", OWN_KEY_DIFF_HOLD],
    ]);
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
      balanceMicroUsd: FUNDING,
      reservedMicroUsd: 0,
    });
  });

  // #591-T25, changed by #605: a claim takes no hold and no lock of the balance row, so it no longer waits for a release.
  // #605-T40
  it("a claim that starts while a release is in flight does not wait for it, and the release and the claim leave the journal consistent", async () => {
    const fixture = await start({ funding: 500_000 });
    const stranded = await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);
    fixture.clock.advance(1);
    const next = await fixture.enqueueNew({ prNumber: 900 });

    const staged = await releaseWhile(fixture, stranded.id, () =>
      fixture.queue.claimNext("runner-b", ENGINES),
    );

    expect(staged.before).toBe("done");
    expect(staged.other?.job.id).toBe(next.id);
    expect((await entriesOf(fixture, stranded.id)).map((e) => e.type)).toEqual([
      "reservation",
      "release",
    ]);
    // The old hold is given back and the new job holds nothing.
    expect(await journalOf(fixture).balance()).toEqual({
      balanceMicroUsd: 500_000,
      reservedMicroUsd: 0,
    });
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
    });
  });

  // #591-T26
  it("does not count a hold that a racing writer released between the finding and the release", async () => {
    const fixture = await start();
    const job = await endedWhileOff(fixture);
    await setBillingSwitch(fixture.db, true);
    let finderQueries = 0;
    let racer: Promise<unknown> | undefined;
    // The finder asks twice (raw statements); after its answer, another writer releases the same hold on its own connection.
    const plugin = afterQueryPlugin(async (query) => {
      if (query.kind !== "RawNode") return;
      finderQueries += 1;
      if (finderQueries !== 2) return;
      racer = journalOf(fixture).release(job.id);
      await racer;
    });

    const result = await releaseStrandedHolds(
      fixture.db.withPlugin(plugin),
      fixture.clock.now,
    );

    expect(finderQueries).toBe(2);
    await expect(racer).resolves.toMatchObject({ ok: true, created: true });
    // The racing writer released it; this run released nothing and says so.
    expect(result).toEqual({ released: 0 });
    expect(
      (await entriesOf(fixture, job.id)).filter((e) => e.type === "release"),
    ).toHaveLength(1);
  });
  /**
   * Two workspaces with one ended job and one open hold each, the job ids in the opposite order to the workspace ids (the
   * job of the workspace that sorts last has the smaller id). The jobs ended without a settlement, as if billing had been off.
   */
  async function twoWorkspacesWithOppositeOrders(fixture: JobQueueFixture) {
    const second = await addWorkspace(fixture.db, "second-591");
    const [firstWorkspace, lastWorkspace] = [
      fixture.workspaceId,
      second,
    ].sort();
    if (firstWorkspace === undefined || lastWorkspace === undefined)
      throw new Error("Two workspaces were expected.");
    const template = await fixture.db
      .selectFrom("jobs")
      .selectAll()
      .limit(1)
      .executeTakeFirst();
    const base =
      template ??
      (await (async () => {
        const created = await fixture.enqueueNew({ prNumber: 800 });
        return fixture.db
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", created.id)
          .executeTakeFirstOrThrow();
      })());
    /** A repository of the workspace (a job and its repository belong to the same workspace). */
    async function repositoryOf(workspaceId: string, externalId: string) {
      if (workspaceId === fixture.workspaceId) return base.repository_id;
      const integration = await createIntegrationsRepository(
        fixture.db,
        workspaceId,
        fixture.clock.now,
      ).create({
        type: "github_app",
        displayName: "other",
        externalId,
        config: {},
      });
      const repositories = createRepositoriesRepository(
        fixture.db,
        workspaceId,
        fixture.clock.now,
      );
      await repositories.reconcile(integration.id, [
        {
          integrationId: integration.id,
          externalId,
          fullName: "other/widgets",
          url: "https://github.test/other/widgets",
        },
      ]);
      const [repository] = await repositories.list({
        integrationId: integration.id,
      });
      if (repository === undefined) throw new Error("No repository.");
      return repository.id;
    }
    const jobs: Array<{ workspaceId: string; jobId: string }> = [];
    for (const [index, workspaceId] of [
      lastWorkspace,
      firstWorkspace,
    ].entries()) {
      const jobId = `job-${String(index)}-591`;
      await fixture.db
        .insertInto("jobs")
        .values({
          ...base,
          id: jobId,
          workspace_id: workspaceId,
          repository_id: await repositoryOf(workspaceId, "9001"),
          pr_number: 810 + index,
          head_sha: sha(String(index)),
          status: "succeeded",
          lease_token: null,
          lease_expires_at: null,
        })
        .execute();
      await fundWorkspace(fixture.db, workspaceId, FUNDING);
      await createBillingJournalRepository(
        fixture.db,
        workspaceId,
        fixture.clock.now,
      ).reserve(OWN_KEY_DIFF_HOLD, jobId);
      jobs.push({ workspaceId, jobId });
    }
    // The job of the last workspace has the smaller id.
    expect(jobs.map((job) => job.jobId)).toEqual(["job-0-591", "job-1-591"]);
    return { firstWorkspace, lastWorkspace, jobs };
  }

  /** The workspaces in the order in which their holds were released (the order of the journal's sequence). */
  async function releaseOrder(fixture: JobQueueFixture) {
    const rows = await fixture.db
      .selectFrom("billing_journal_entries")
      .select("workspace_id")
      .where("type", "=", "release")
      .orderBy("seq")
      .execute();
    return rows.map((row) => row.workspace_id);
  }

  // #591-T27
  it("the settlement of ended jobs locks the workspaces in the order of the switch-on: by workspace, not by job id", async () => {
    const fixture = await start();
    const { firstWorkspace, lastWorkspace, jobs } =
      await twoWorkspacesWithOppositeOrders(fixture);

    await fixture.db.transaction().execute((trx) =>
      settleEndedJobs(
        trx,
        jobs.map((job) => job.jobId),
        fixture.clock.now,
      ),
    );

    // Two transactions that take the balance rows of several workspaces must take them in one global order, or two of
    // them can each hold what the other waits for.
    expect(await releaseOrder(fixture)).toEqual([
      firstWorkspace,
      lastWorkspace,
    ]);
  });

  // #591-T28
  it("the switch-on releases the holds of several workspaces in the same order: by workspace, then job", async () => {
    const fixture = await start();
    const { firstWorkspace, lastWorkspace } =
      await twoWorkspacesWithOppositeOrders(fixture);

    expect(
      await fixture.db
        .transaction()
        .execute((trx) => releaseStrandedHolds(trx, fixture.clock.now)),
    ).toEqual({ released: 2 });

    expect(await releaseOrder(fixture)).toEqual([
      firstWorkspace,
      lastWorkspace,
    ]);
  });

  // #605-T41
  it("finds nothing for a job claimed since #605 that ended while billing was off: it holds nothing, so nothing is stranded", async () => {
    const fixture = await start();
    pr += 1;
    fixture.clock.advance(1);
    const job = await fixture.enqueueNew({ prNumber: pr });
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    await setBillingSwitch(fixture.db, false);
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", delivered);
    await setBillingSwitch(fixture.db, true);

    expect(await findStrandedHolds(fixture.db, 10)).toEqual([]);
    expect(await releaseStrandedHolds(fixture.db, fixture.clock.now)).toEqual({
      released: 0,
    });

    expect(await entriesOf(fixture, job.id)).toEqual([]);
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
      balanceMicroUsd: FUNDING,
      reservedMicroUsd: 0,
      strandedHoldCount: 0,
    });
  });
});
