// SPDX-License-Identifier: Apache-2.0

// A new push supersedes the running automatic review (#397), on SQLite and, when TEST_DATABASE_URL is set, on
// Postgres: which running jobs are superseded, that the new job is claimable at once while the old one drains, what
// the heartbeat and the report of the superseded claim do, and what the usage record of such a run is: not a run of
// the quota, its measured cost counted, an unknown cost unknown.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { SUPERSEDED_DRAIN_MS } from "../db/repositories/jobs-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import type { Database } from "../db/schema.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";

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

const USAGE = {
  model: "m",
  promptTokens: 600,
  completionTokens: 150,
  totalTokens: 750,
  aiCalls: 1,
  fallbackUsed: false,
  costUsd: 0.0042,
};
const SUPERSEDED_RESULT = {
  ok: false,
  durationMs: 5,
  commentUrl: null,
  errorCode: "superseded",
  logTail: "superseded",
  logTruncated: false,
  usage: USAGE,
};

describe.each(databases)("superseding a running review on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function start() {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
    });
    const records = createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    /** A running automatic job whose holder understands the supersede, with its claim. */
    async function running(
      overrides: Parameters<typeof fixture.enqueue>[0] = {},
      accepts = true,
    ) {
      const queued = await fixture.enqueueNew(overrides);
      const claimed = await fixture.queue.claimNext("pool", undefined, {
        jobId: queued.id,
        ...(accepts ? { acceptsSupersede: true } : {}),
      });
      if (claimed === null) throw new Error("the job was not claimed");
      return claimed;
    }
    return { fixture, records, running };
  }

  // #397-T02
  run(
    "supersedes the running automatic job of a holder that understands it, and keeps its claim for the drain",
    async () => {
      const { fixture, running } = await start();
      const old = await running({ headSha: sha("a") });
      const before = await fixture.tokenOf(old.job.id);

      const result = await fixture.enqueue({ headSha: sha("b") });

      expect(result.status).toBe("created");
      if (result.status !== "created") return;
      expect(result.supersededJobIds).toEqual([old.job.id]);
      expect(result.job.status).toBe("queued");
      const after = await fixture.queue.get(old.job.id);
      expect(after).toMatchObject({
        status: "superseded",
        supersededBy: result.job.id,
        finishedAt: fixture.clock.now().toISOString(),
        leaseExpiresAt: new Date(
          fixture.clock.now().getTime() + SUPERSEDED_DRAIN_MS,
        ).toISOString(),
        runnerId: "pool",
      });
      expect(await fixture.tokenOf(old.job.id)).toBe(before);
    },
  );

  // #397-T03
  run(
    "leaves alone a running job whose holder does not understand it, and a job a person started",
    async () => {
      const { fixture, running } = await start();
      const old = await running({ headSha: sha("a") }, false);
      const first = await fixture.enqueue({ headSha: sha("b") });
      expect((await fixture.queue.get(old.job.id))?.status).toBe("running");
      expect(first.status === "created" && first.supersededJobIds).toEqual([]);

      const person = await running({
        prNumber: 9,
        prUrl: "https://github.test/acme/widgets/pull/9",
        headSha: sha("c"),
        triggerKind: "manual",
      });
      const next = await fixture.enqueue({
        prNumber: 9,
        prUrl: "https://github.test/acme/widgets/pull/9",
        headSha: sha("d"),
      });

      expect((await fixture.queue.get(person.job.id))?.status).toBe("running");
      expect(next.status === "created" && next.job.status).toBe("queued");
    },
  );

  // #397-T03
  run(
    "does not supersede the running job of another pull request, kind or head of a person",
    async () => {
      const { fixture, running } = await start();
      const other = await running({
        prNumber: 8,
        prUrl: "https://github.test/acme/widgets/pull/8",
        headSha: sha("a"),
      });

      await fixture.enqueue({ headSha: sha("b") });

      expect((await fixture.queue.get(other.job.id))?.status).toBe("running");
    },
  );

  // #397-T04
  run(
    "lets the new job be claimed at once, while the old one still holds its lease",
    async () => {
      const { fixture, running } = await start();
      const old = await running({ headSha: sha("a") });
      await fixture.enqueue({ headSha: sha("b") });

      const next = await fixture.queue.claimNext("pool-2", undefined, {
        acceptsSupersede: true,
      });

      expect(next?.job).toMatchObject({ headSha: sha("b"), status: "running" });
      const states = await fixture.db
        .selectFrom("jobs")
        .select(["id", "status"])
        .where("pr_number", "=", 7)
        .execute();
      expect(states.filter((job) => job.status === "running")).toHaveLength(1);
      expect((await fixture.queue.get(old.job.id))?.status).toBe("superseded");
    },
  );

  // #397-T05
  run(
    "answers the heartbeat of the superseded claim `superseded` without extending its lease, until the drain is over",
    async () => {
      const { fixture, running } = await start();
      const old = await running({ headSha: sha("a") });
      await fixture.enqueue({ headSha: sha("b") });
      const lease = (await fixture.queue.get(old.job.id))?.leaseExpiresAt;

      fixture.clock.advance(30_000);
      const beat = await fixture.queue.heartbeat(old.job.id, old.leaseToken);

      expect(beat.status).toBe("superseded");
      expect((await fixture.queue.get(old.job.id))?.leaseExpiresAt).toBe(lease);
      fixture.clock.advance(SUPERSEDED_DRAIN_MS);
      expect(await fixture.queue.heartbeat(old.job.id, old.leaseToken)).toEqual(
        {
          status: "not_holder",
        },
      );
    },
  );

  // #397-T06
  run(
    "stores the report of the superseded claim once, settles its record with the measured cost and keeps the job superseded",
    async () => {
      const { fixture, records, running } = await start();
      const old = await running({ headSha: sha("a") });
      await fixture.enqueue({ headSha: sha("b") });
      const outcome = {
        ok: false as const,
        errorCode: "superseded",
        result: SUPERSEDED_RESULT,
      };

      const done = await fixture.queue.complete(
        old.job.id,
        old.leaseToken,
        outcome,
      );

      expect(done.status).toBe("completed");
      expect((await fixture.queue.get(old.job.id))?.status).toBe("superseded");
      expect(await records.get(old.job.id)).toMatchObject({
        state: "settled",
        settledReason: "superseded",
        costMicroUsd: 4200,
        promptTokens: 600,
        completionTokens: 150,
      });
      // The same report again changes nothing; another one is a conflict.
      expect(
        (await fixture.queue.complete(old.job.id, old.leaseToken, outcome))
          .status,
      ).toBe("already_completed");
      expect(
        (
          await fixture.queue.complete(old.job.id, old.leaseToken, {
            ...outcome,
            result: { ...SUPERSEDED_RESULT, logTail: "other" },
          })
        ).status,
      ).toBe("outcome_conflict");
      // A wrong token is not the holder.
      expect(
        (await fixture.queue.complete(old.job.id, "other", outcome)).status,
      ).toBe("not_holder");
    },
  );

  // #397-T06
  run(
    "leaves the record void when the superseded run never used the model",
    async () => {
      const { fixture, records, running } = await start();
      const old = await running({ headSha: sha("a") });
      await fixture.enqueue({ headSha: sha("b") });

      await fixture.queue.complete(old.job.id, old.leaseToken, {
        ok: false,
        errorCode: "superseded",
        result: {
          ...SUPERSEDED_RESULT,
          usage: {
            ...USAGE,
            aiCalls: 0,
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            costUsd: 0,
          },
        },
      });

      expect((await records.get(old.job.id))?.state).toBe("void");
    },
  );

  // #397-T07
  run(
    "settles the record with an unknown cost when nobody reports before the drain ends, and does not bill it",
    async () => {
      const { fixture, records, running } = await start();
      const old = await running({ headSha: sha("a") });
      await fixture.enqueue({ headSha: sha("b") });
      expect((await records.get(old.job.id))?.state).toBe("reserved");

      fixture.clock.advance(SUPERSEDED_DRAIN_MS - 1000);
      await fixture.queue.expireStaleJobs();
      expect((await records.get(old.job.id))?.state).toBe("reserved");
      fixture.clock.advance(2000);
      await fixture.queue.expireStaleJobs();

      expect(await records.get(old.job.id)).toMatchObject({
        state: "settled",
        settledReason: "superseded",
        costMicroUsd: null,
        promptTokens: null,
      });
      const since = "2026-01-01T00:00:00.000Z";
      expect(await records.sumSettledCostMicroUsd(since, "own")).toBe(0);
    },
  );

  // #397-T08
  run(
    "is not a run of the quota from the moment it is superseded, while its cost counts as usage",
    async () => {
      const { fixture, records, running } = await start();
      const old = await running({ headSha: sha("a") });
      const since = "2026-01-01T00:00:00.000Z";
      expect((await records.countByKind(since)).diff).toBe(1);

      await fixture.enqueue({ headSha: sha("b") });
      expect((await records.countByKind(since)).diff).toBe(0);

      await fixture.queue.complete(old.job.id, old.leaseToken, {
        ok: false,
        errorCode: "superseded",
        result: SUPERSEDED_RESULT,
      });
      expect((await records.countByKind(since)).diff).toBe(0);
      // T09: the measured cost is usage like any other, and the summary lists the run apart.
      expect(await records.sumSettledCostMicroUsd(since, "own")).toBe(4200);
      expect(
        await records.summarize({
          from: since,
          to: "2027-01-01T00:00:00.000Z",
        }),
      ).toEqual([
        {
          reviewKind: "diff",
          keyMode: "own",
          recordCount: 0,
          settledCount: 0,
          supersededCount: 1,
          knownCostMicroUsd: 4200,
          unknownCostCount: 0,
        },
      ]);
      // The new job, a real run, counts.
      await fixture.queue.claimNext("pool-2");
      expect((await records.countByKind(since)).diff).toBe(1);
    },
  );

  // #397-T13
  run(
    "names the head of a superseded run that ran among the heads that may have published, not one superseded while it waited",
    async () => {
      const { fixture, running } = await start();
      await running({ headSha: sha("a") });
      const second = await fixture.enqueue({ headSha: sha("b") });
      fixture.clock.advance(1000);
      // Superseded while it waited: it never ran.
      await fixture.enqueue({ headSha: sha("c") });
      fixture.clock.advance(1000);
      const last = await fixture.enqueue({ headSha: sha("d") });
      if (second.status !== "created" || last.status !== "created") return;

      const attempted = await createJobsRepository(
        fixture.db,
        fixture.workspaceId,
        { now: fixture.clock.now },
      ).attemptedShas({
        repositoryId: fixture.repositoryId,
        prNumber: 7,
        reviewKind: "diff",
        excludeJobId: last.job.id,
      });

      expect(attempted.shas).toEqual([sha("a")]);
    },
  );
});
