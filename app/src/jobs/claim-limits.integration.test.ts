// SPDX-License-Identifier: Apache-2.0

// The limits and the suspension of a workspace at claim (#277; src/usage/README.md, "Limits"), on SQLite and,
// when TEST_DATABASE_URL is set, on Postgres. The check and the reservation of the usage record happen in
// one transaction of the queue's claim, so a refused job leaves no record and two claims never pass the last unit.
// The runner API tests (integration-tests/http/runner-api-limits.integration.test.ts) pin what a runner is
// handed on each claim path.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import {
  createJobQueueFixture,
  sha,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type {
  EntitlementLimits,
  EntitlementsData,
} from "../workspaces/entitlements.ts";
import { createJobQueue } from "./job-queue.ts";
import { createRunnerQueue } from "./runner-queue.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PERIOD_START = "2026-10-01T00:00:00.000Z";
const ENGINES = ["pr-agent", "opencode"] as const;

const databases: Array<
  [string, (() => Promise<Kysely<Database>>) | undefined]
> = [
  ["SQLite", undefined],
  [
    "Postgres",
    hasPostgres()
      ? async () => (await createPostgresTestDatabase({ poolMax: 12 })).db
      : undefined,
  ],
];

type EntitlementOverrides = Partial<Omit<EntitlementsData, "limits">> & {
  limits?: Partial<EntitlementLimits>;
};

function entitlements(overrides: EntitlementOverrides = {}): EntitlementsData {
  const { limits, ...rest } = overrides;
  return {
    planLabel: "plan",
    keyMode: "own",
    periodStart: PERIOD_START,
    suspended: false,
    suspensionCode: null,
    ...rest,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ...limits,
    },
  };
}

describe.each(databases)("the limits at claim on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function start() {
    const database = await open?.();
    return createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
    });
  }

  function entitlementsOf(fixture: JobQueueFixture, workspaceId?: string) {
    return createWorkspaceEntitlementsRepository(
      fixture.db,
      workspaceId ?? fixture.workspaceId,
      fixture.clock.now,
    );
  }

  const setEntitlements = (
    fixture: JobQueueFixture,
    overrides: EntitlementOverrides,
    workspaceId?: string,
  ) => entitlementsOf(fixture, workspaceId).put(entitlements(overrides), null);

  const recordsOf = (fixture: JobQueueFixture) =>
    createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );

  const allRecords = (fixture: JobQueueFixture) =>
    fixture.db.selectFrom("usage_records").selectAll().execute();

  let next = 0;
  /** A new waiting job on a pull request of its own (so any number can run at once). */
  function enqueue(
    fixture: JobQueueFixture,
    reviewKind: "diff" | "dynamic" = "diff",
  ) {
    next += 1;
    // Jobs are claimed oldest first: each one is a millisecond younger than the one before.
    fixture.clock.advance(1);
    return fixture.enqueueNew({
      prNumber: 100 + next,
      reviewKind,
    });
  }

  /** Claims, notes the key and completes a run with a cost, as a runner would. */
  async function runToCompletion(
    fixture: JobQueueFixture,
    options: { costUsd: number | null; managed: boolean },
  ) {
    const job = await enqueue(fixture);
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    expect(claimed?.job.id).toBe(job.id);
    if (options.managed) await recordsOf(fixture).setKeyMode(job.id, "managed");
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {
        ok: true,
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          costUsd: options.costUsd,
        },
      },
    });
    return job;
  }

  // #277-T01
  run("claims as before when the workspace has no entitlements", async () => {
    const fixture = await start();
    const jobs = [await enqueue(fixture), await enqueue(fixture)];

    for (const job of jobs)
      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);

    expect(await allRecords(fixture)).toHaveLength(2);
  });

  // #277-T01
  run(
    "claims as before when the entitlements put no limit on anything",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, {});
      const job = await enqueue(fixture);

      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
    },
  );

  // #277-T02
  run(
    "runs Diff jobs up to the limit and fails the next one, which no runner gets",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 2 } });
      const [first, second, third] = [
        await enqueue(fixture),
        await enqueue(fixture),
        await enqueue(fixture),
      ];

      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(
        first.id,
      );
      expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(
        second.id,
      );
      expect(await fixture.queue.claimNext("runner-c")).toBeNull();

      expect(await fixture.queue.get(third.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
        runnerId: expect.any(String),
        leaseExpiresAt: null,
        finishedAt: fixture.clock.now().toISOString(),
        attempts: 0,
      });
      expect(await recordsOf(fixture).get(third.id)).toBeUndefined();
      expect(await allRecords(fixture)).toHaveLength(2);
    },
  );

  // #277-T02
  run(
    "counts runs that settled as well as runs that are still reserved",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 2 } });
      await runToCompletion(fixture, { costUsd: 0.01, managed: false });
      await enqueue(fixture);
      expect(await fixture.queue.claimNext("runner-a")).not.toBeNull();
      const refused = await enqueue(fixture);

      expect(await fixture.queue.claimNext("runner-b")).toBeNull();

      expect(await fixture.queue.get(refused.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
    },
  );

  // #277-T03
  run(
    "fails every Dynamic job when the Dynamic limit is 0 and leaves Diff jobs alone",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { dynamicRunsPerPeriod: 0 } });
      const dynamic = await enqueue(fixture, "dynamic");
      const diff = await enqueue(fixture, "diff");

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      expect(claimed?.job.id).toBe(diff.id);
      expect(await fixture.queue.get(dynamic.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
      expect(await recordsOf(fixture).get(dynamic.id)).toBeUndefined();
    },
  );

  // #277-T03
  run("counts the runs of each kind on their own", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { diffRunsPerPeriod: 1, dynamicRunsPerPeriod: 1 },
    });
    const diff = await enqueue(fixture, "diff");
    const dynamic = await enqueue(fixture, "dynamic");

    expect((await fixture.queue.claimNext("runner-a", ENGINES))?.job.id).toBe(
      diff.id,
    );
    expect((await fixture.queue.claimNext("runner-b", ENGINES))?.job.id).toBe(
      dynamic.id,
    );
  });

  // #277-T04
  run(
    "fails a managed job once the settled managed cost reaches the limit, and not a job on the own key",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        keyMode: "managed",
        limits: { managedCostLimitMicroUsd: 5_000_000 },
      });
      await runToCompletion(fixture, { costUsd: 3, managed: true });
      await runToCompletion(fixture, { costUsd: 2, managed: true });
      const refused = await enqueue(fixture);

      expect(await fixture.queue.claimNext("runner-a")).toBeNull();

      expect(await fixture.queue.get(refused.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
      expect(await recordsOf(fixture).get(refused.id)).toBeUndefined();
      // The workspace now reviews on its own key: the cost limit is about the operator's.
      await setEntitlements(fixture, {
        keyMode: "own",
        limits: { managedCostLimitMicroUsd: 5_000_000 },
      });
      const own = await enqueue(fixture);
      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(own.id);
    },
  );

  // #277-T04
  run("lets a managed job run while the cost is below the limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: { managedCostLimitMicroUsd: 5_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 4.999999, managed: true });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  // #277-T04
  run(
    "does not count the cost of a run on the own key against the managed limit",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        keyMode: "managed",
        limits: { managedCostLimitMicroUsd: 1_000_000 },
      });
      await runToCompletion(fixture, { costUsd: 9, managed: false });
      const job = await enqueue(fixture);

      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
    },
  );

  // #277-T05
  run(
    "fails every job of a suspended workspace and runs the next one once the suspension is cleared",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        suspended: true,
        suspensionCode: "overdue",
      });
      const diff = await enqueue(fixture, "diff");
      const dynamic = await enqueue(fixture, "dynamic");

      expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

      for (const job of [diff, dynamic])
        expect(await fixture.queue.get(job.id)).toMatchObject({
          status: "failed",
          errorCode: "workspace_suspended",
        });
      expect(await allRecords(fixture)).toEqual([]);
      await setEntitlements(fixture, {});
      const later = await enqueue(fixture);
      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(
        later.id,
      );
    },
  );

  // #277-T05
  run(
    "applies the default entitlements to a workspace without a row",
    async () => {
      const fixture = await start();
      await createInstanceSettingsRepository(fixture.db, fixture.clock.now).set(
        "default_entitlements",
        entitlements({ suspended: true, suspensionCode: "overdue" }),
        null,
      );
      const job = await enqueue(fixture);

      expect(await fixture.queue.claimNext("runner-a")).toBeNull();

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "workspace_suspended",
      });
    },
  );

  // #271 follow-up: unreadable entitlements fail closed
  run(
    "fails the job instead of running it when the stored entitlements cannot be read",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 5 } });
      await fixture.db
        .updateTable("workspace_entitlements")
        .set({ limits: "{not json" })
        .execute();
      const job = await enqueue(fixture);

      expect(await fixture.queue.claimNext("runner-a")).toBeNull();

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "entitlements_invalid",
      });
      expect(await allRecords(fixture)).toEqual([]);
    },
  );

  // #277-T07
  run("leaves no usage record for a refused job", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 0 } });
    await enqueue(fixture);

    await fixture.queue.claimNext("runner-a");

    expect(await allRecords(fixture)).toEqual([]);
  });

  // #277-T08
  run(
    "runs a job claimed again after a lost lease although the limit is reached, with the one record it has",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
      const job = await enqueue(fixture);
      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
      fixture.clock.advance(3 * MINUTE);

      const again = await fixture.queue.claimNext("runner-b");

      expect(again?.job).toMatchObject({ id: job.id, attempts: 1 });
      expect(await allRecords(fixture)).toHaveLength(1);
      expect(await recordsOf(fixture).get(job.id)).toMatchObject({
        state: "reserved",
      });
    },
  );

  // #277-T08
  run(
    "does not let a job that lost its lease run once the workspace is suspended, and voids its record",
    async () => {
      const fixture = await start();
      const job = await enqueue(fixture);
      await fixture.queue.claimNext("runner-a");
      await setEntitlements(fixture, {
        suspended: true,
        suspensionCode: "overdue",
      });
      fixture.clock.advance(3 * MINUTE);

      expect(await fixture.queue.claimNext("runner-b")).toBeNull();

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "workspace_suspended",
      });
      expect(await recordsOf(fixture).get(job.id)).toMatchObject({
        state: "void",
      });
    },
  );

  // #277-T09
  run(
    "stops counting earlier records the moment the period start moves forward",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
      await enqueue(fixture);
      expect(await fixture.queue.claimNext("runner-a")).not.toBeNull();
      const refused = await enqueue(fixture);
      expect(await fixture.queue.claimNext("runner-b")).toBeNull();
      expect((await fixture.queue.get(refused.id))?.status).toBe("failed");
      fixture.clock.advance(10 * SECOND);
      await setEntitlements(fixture, {
        limits: { diffRunsPerPeriod: 1 },
        periodStart: fixture.clock.now().toISOString(),
      });
      fixture.clock.advance(10 * SECOND);
      const allowed = await enqueue(fixture);

      expect((await fixture.queue.claimNext("runner-c"))?.job.id).toBe(
        allowed.id,
      );
    },
  );

  // #277-T09
  run("counts a run that started exactly at the period start", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { diffRunsPerPeriod: 1 },
      periodStart: fixture.clock.now().toISOString(),
    });
    await enqueue(fixture);
    await fixture.queue.claimNext("runner-a");
    const refused = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-b")).toBeNull();

    expect((await fixture.queue.get(refused.id))?.errorCode).toBe(
      "quota_exhausted",
    );
  });

  // #277-T10
  run("does not count a void record", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
    const first = await enqueue(fixture);
    const claimed = await fixture.queue.claimNext("runner-a");
    // A run that failed without using the model: its record is void.
    await fixture.queue.complete(first.id, claimed?.leaseToken ?? "", {
      ok: false,
      errorCode: "checkout_incomplete",
    });
    expect(await recordsOf(fixture).get(first.id)).toMatchObject({
      state: "void",
    });
    const second = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(second.id);
  });

  // #277-T11
  run(
    "counts a settled record of unknown cost as a run and adds nothing to the cost",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        keyMode: "managed",
        limits: {
          diffRunsPerPeriod: 2,
          managedCostLimitMicroUsd: 1_000_000,
        },
      });
      await runToCompletion(fixture, { costUsd: null, managed: true });
      await runToCompletion(fixture, { costUsd: 0.5, managed: true });
      const refused = await enqueue(fixture);

      // Two runs counted (the limit of 2); the cost sum is 0.5 of 1.0, so only the count refuses.
      expect(await fixture.queue.claimNext("runner-a")).toBeNull();

      expect(await fixture.queue.get(refused.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
    },
  );

  // #277-T11
  run(
    "does not let unknown costs refuse a managed job on their own",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        keyMode: "managed",
        limits: { managedCostLimitMicroUsd: 1 },
      });
      await runToCompletion(fixture, { costUsd: null, managed: true });
      await runToCompletion(fixture, { costUsd: null, managed: true });
      const job = await enqueue(fixture);

      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
    },
  );

  // #277-T13
  run("leaves another workspace alone when one is at its limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 0 } });
    const refused = await enqueue(fixture);
    fixture.clock.advance(1000);
    const other = await addWorkspace(fixture.db, "other");
    const otherJob = await enqueueInWorkspace(fixture, other);

    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed?.job).toMatchObject({ id: otherJob, workspaceId: other });
    expect((await fixture.queue.get(refused.id))?.status).toBe("failed");
  });

  // #277-T06
  run(
    "lets exactly one of two claims at the same moment take the last unit",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
      const one = await enqueue(fixture);
      const two = await enqueue(fixture);

      // Two connections of one pool on Postgres; on SQLite the database lock serializes them.
      const answers = await Promise.all([
        fixture.queue.claimNext("runner-a"),
        fixture.queue.claimNext("runner-b"),
      ]);

      const winners = answers.filter((answer) => answer !== null);
      expect(winners).toHaveLength(1);
      const statuses = await Promise.all(
        [one, two].map(
          async (job) => (await fixture.queue.get(job.id))?.status,
        ),
      );
      expect(statuses.sort()).toEqual(["failed", "running"]);
      expect(await allRecords(fixture)).toHaveLength(1);
    },
  );

  // #277-T06
  run(
    "never lets many claims at the same moment pass more than the limit",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 3 } });
      for (let index = 0; index < 8; index += 1) await enqueue(fixture);

      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          fixture.queue.claimNext(`runner-${index}`),
        ),
      );

      expect(answers.filter((answer) => answer !== null)).toHaveLength(3);
      expect(await allRecords(fixture)).toHaveLength(3);
    },
  );

  // #277-T02
  run(
    "reports each refusal with its code and detail once the claim committed",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        suspended: false,
        limits: { diffRunsPerPeriod: 0 },
      });
      const refusals: unknown[] = [];
      const queue = createRunnerQueue(fixture.db, {
        now: fixture.clock.now,
        onRefused: (refusal) => refusals.push(refusal),
      });
      const job = await enqueue(fixture);

      expect(await queue.claimNext("runner-a")).toBeNull();

      expect(refusals).toEqual([
        {
          jobId: job.id,
          workspaceId: fixture.workspaceId,
          errorCode: "quota_exhausted",
          detail: "diff_runs",
        },
      ]);
    },
  );

  // #277-T02
  run(
    "claims the next waiting job after refusing one, in the same call",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { dynamicRunsPerPeriod: 0 } });
      const dynamic = await enqueue(fixture, "dynamic");
      fixture.clock.advance(1000);
      const diff = await enqueue(fixture, "diff");

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      expect(claimed?.job.id).toBe(diff.id);
      expect((await fixture.queue.get(dynamic.id))?.status).toBe("failed");
    },
  );

  // #277-T02
  run(
    "refuses a job claimed by its id and answers nothing, like any job that cannot be claimed",
    async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 0 } });
      const job = await enqueue(fixture);

      const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
        workerCredential: true,
        jobId: job.id,
      });

      expect(claimed).toBeNull();
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
    },
  );
});

/** Queues a job on a repository of its own in another workspace and returns its id. */
async function enqueueInWorkspace(
  fixture: JobQueueFixture,
  workspaceId: string,
): Promise<string> {
  const integration = await createIntegrationsRepository(
    fixture.db,
    workspaceId,
    fixture.clock.now,
  ).create({
    type: "github_app",
    displayName: "other",
    externalId: "9999",
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
      externalId: "8001",
      fullName: "other/widgets",
      url: "https://github.test/other/widgets",
    },
  ]);
  const [repository] = await repositories.list({
    integrationId: integration.id,
  });
  if (repository === undefined)
    throw new Error("The repository of the other workspace is missing.");
  const result = await createJobQueue(fixture.db, workspaceId, {
    now: fixture.clock.now,
  }).enqueue({
    repositoryId: repository.id,
    prNumber: 1,
    prUrl: "https://github.test/other/widgets/pull/1",
    headSha: sha("f"),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
  });
  if (result.status !== "created")
    throw new Error("The job of the other workspace was not created.");
  return result.job.id;
}
