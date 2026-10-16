// SPDX-License-Identifier: Apache-2.0

// The usage records of a workspace against a real SQLite file: reserving once per job, settling or voiding
// once, the counting reads and the cursor page. Isolation between workspaces is in
// scoped-isolation.integration.test.ts; the claim and the completion that drive the records are in
// integration-tests/http/runner-api-usage.integration.test.ts.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";

const SETTLED = (costMicroUsd: number | null) =>
  ({
    state: "settled",
    costMicroUsd,
    promptTokens: 1000,
    completionTokens: 100,
  }) as const;

async function setup() {
  const fixture = await createJobQueueFixture({ dynamicReview: true });
  let now = new Date("2026-10-14T12:00:00.000Z");
  const records = createUsageRecordsRepository(
    fixture.db,
    fixture.workspaceId,
    () => now,
  );
  let pull = 0;
  /** A new job on its own pull request, so jobs never share a slot. */
  const newJob = async (reviewKind: "diff" | "dynamic" = "diff") => {
    pull += 1;
    return fixture.enqueueNew({ prNumber: pull, reviewKind });
  };
  return {
    ...fixture,
    records,
    newJob,
    setNow: (next: string) => {
      now = new Date(next);
    },
  };
}

describe("reserving a record", () => {
  // #272-T01
  it("stores a reserved record with the kind of the job and the key mode", async () => {
    const t = await setup();
    const job = await t.newJob("dynamic");

    await t.records.reserve(job.id, "managed");

    expect(await t.records.get(job.id)).toMatchObject({
      id: expect.any(String),
      workspaceId: t.workspaceId,
      jobId: job.id,
      reviewKind: "dynamic",
      keyMode: "managed",
      modelTier: null,
      state: "reserved",
      costMicroUsd: null,
      promptTokens: null,
      completionTokens: null,
      reservedAt: "2026-10-14T12:00:00.000Z",
      settledAt: null,
    });
  });

  // #272-T05
  it("reuses the record when the same job is reserved again", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "own");
    const first = await t.records.get(job.id);
    t.setNow("2026-10-14T12:05:00.000Z");

    await t.records.reserve(job.id, "managed");

    expect(await t.records.get(job.id)).toEqual(first);
    const { rows } = await sql<{
      n: number;
    }>`select count(*) as n from usage_records`.execute(t.db);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("changes the key mode of a reserved record and of nothing else", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "own");

    await t.records.setKeyMode(job.id, "managed");
    expect((await t.records.get(job.id))?.keyMode).toBe("managed");

    await t.records.settle(job.id, SETTLED(5));
    await t.records.setKeyMode(job.id, "own");
    expect((await t.records.get(job.id))?.keyMode).toBe("managed");
  });

  it("refuses a key mode the table does not know", async () => {
    const t = await setup();
    const job = await t.newJob();

    await expect(
      t.records.reserve(job.id, "shared" as never),
    ).rejects.toThrow();
  });
});

describe("settling a record", () => {
  // #272-T02
  it("settles with the cost and the tokens and stamps the time", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "own");
    t.setNow("2026-10-14T12:10:00.000Z");

    await t.records.settle(job.id, SETTLED(12346));

    expect(await t.records.get(job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: 12346,
      promptTokens: 1000,
      completionTokens: 100,
      reservedAt: "2026-10-14T12:00:00.000Z",
      settledAt: "2026-10-14T12:10:00.000Z",
    });
  });

  // #272-T03
  it("settles with an unknown cost as settled, not void", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "own");

    await t.records.settle(job.id, SETTLED(null));

    expect(await t.records.get(job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: null,
    });
  });

  // #272-T04
  it("voids a record without a time of settlement", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "own");

    await t.records.settle(job.id, { state: "void" });

    expect(await t.records.get(job.id)).toMatchObject({
      state: "void",
      settledAt: null,
      costMicroUsd: null,
      promptTokens: null,
    });
  });

  // #272-T07
  it("never changes a record that is settled or void", async () => {
    const t = await setup();
    const settled = await t.newJob();
    const voided = await t.newJob();
    await t.records.reserve(settled.id, "own");
    await t.records.reserve(voided.id, "own");
    await t.records.settle(settled.id, SETTLED(7));
    await t.records.settle(voided.id, { state: "void" });
    const before = [
      await t.records.get(settled.id),
      await t.records.get(voided.id),
    ];
    t.setNow("2026-10-14T13:00:00.000Z");

    await t.records.settle(settled.id, SETTLED(999));
    await t.records.settle(settled.id, { state: "void" });
    await t.records.settle(voided.id, SETTLED(999));
    await t.records.reserve(voided.id, "managed");

    expect([
      await t.records.get(settled.id),
      await t.records.get(voided.id),
    ]).toEqual(before);
  });

  it("creates the record of a job that was claimed before records existed, in its final state", async () => {
    const t = await setup();
    const job = await t.newJob();

    await t.records.settle(job.id, SETTLED(42));

    expect(await t.records.get(job.id)).toMatchObject({
      state: "settled",
      keyMode: "own",
      costMicroUsd: 42,
    });
  });

  it("dates the record of a job claimed before records existed from its claim", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.queue.claimNext("runner-a");
    await t.db.deleteFrom("usage_records").execute();
    t.setNow("2026-10-14T13:00:00.000Z");

    await t.records.settle(job.id, SETTLED(42));

    expect(await t.records.get(job.id)).toMatchObject({
      state: "settled",
      reservedAt: t.clock.now().toISOString(),
      settledAt: "2026-10-14T13:00:00.000Z",
    });
  });

  it("refuses a final record that is half finished (the table checks it too)", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "own");

    await expect(
      sql`update usage_records set state = 'settled' where job_id = ${job.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow();
    await expect(
      sql`update usage_records set cost_micro_usd = 5 where job_id = ${job.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow();
  });
});

describe("counting", () => {
  it("counts reserved and settled records of a kind since a time, and never void ones", async () => {
    const t = await setup();
    const reserved = await t.newJob("diff");
    const settled = await t.newJob("diff");
    const dynamic = await t.newJob("dynamic");
    const voided = await t.newJob("diff");
    for (const job of [reserved, settled, dynamic, voided])
      await t.records.reserve(job.id, "own");
    await t.records.settle(settled.id, SETTLED(1));
    await t.records.settle(dynamic.id, SETTLED(2));
    await t.records.settle(voided.id, { state: "void" });

    expect(await t.records.countByKind("2026-10-14T00:00:00.000Z")).toEqual({
      diff: 2,
      dynamic: 1,
    });
  });

  it("counts from the time the job was reserved, inclusive", async () => {
    const t = await setup();
    const early = await t.newJob();
    const late = await t.newJob();
    await t.records.reserve(early.id, "own");
    t.setNow("2026-10-15T00:00:00.000Z");
    await t.records.reserve(late.id, "own");

    expect(await t.records.countByKind("2026-10-15T00:00:00.000Z")).toEqual({
      diff: 1,
      dynamic: 0,
    });
    expect(await t.records.countByKind("2026-10-15T00:00:00.001Z")).toEqual({
      diff: 0,
      dynamic: 0,
    });
  });

  it("sums the settled cost of managed runs since a time and treats an unknown cost as nothing", async () => {
    const t = await setup();
    const jobs = [
      await t.newJob(),
      await t.newJob(),
      await t.newJob(),
      await t.newJob(),
      await t.newJob(),
    ];
    const [managedA, managedB, unknown, own, stillReserved] = jobs;
    if (stillReserved === undefined) throw new Error("setup");
    await t.records.reserve(managedA!.id, "managed");
    await t.records.reserve(managedB!.id, "managed");
    await t.records.reserve(unknown!.id, "managed");
    await t.records.reserve(own!.id, "own");
    await t.records.reserve(stillReserved.id, "managed");
    t.setNow("2026-10-14T12:30:00.000Z");
    await t.records.settle(managedA!.id, SETTLED(1_500_000));
    await t.records.settle(managedB!.id, SETTLED(250));
    await t.records.settle(unknown!.id, SETTLED(null));
    await t.records.settle(own!.id, SETTLED(9_000_000));

    expect(
      await t.records.sumSettledCostMicroUsd(
        "2026-10-14T12:00:00.000Z",
        "managed",
      ),
    ).toBe(1_500_250);
    expect(
      await t.records.sumSettledCostMicroUsd(
        "2026-10-14T12:00:00.001Z",
        "managed",
      ),
    ).toBe(0);
  });

  // #361-T05
  it("sums the settled cost of the runs of each key mode on its own, and treats an unknown cost as nothing", async () => {
    const t = await setup();
    const [ownA, ownB, ownUnknown, managed, ownReserved] = [
      await t.newJob(),
      await t.newJob(),
      await t.newJob(),
      await t.newJob(),
      await t.newJob(),
    ];
    if (ownReserved === undefined) throw new Error("setup");
    await t.records.reserve(ownA!.id, "own");
    await t.records.reserve(ownB!.id, "own");
    await t.records.reserve(ownUnknown!.id, "own");
    await t.records.reserve(managed!.id, "managed");
    await t.records.reserve(ownReserved.id, "own");
    t.setNow("2026-10-14T12:30:00.000Z");
    await t.records.settle(ownA!.id, SETTLED(1_000_000));
    await t.records.settle(ownB!.id, SETTLED(40));
    await t.records.settle(ownUnknown!.id, SETTLED(null));
    await t.records.settle(managed!.id, SETTLED(9_000_000));

    const since = "2026-10-14T12:00:00.000Z";
    expect(await t.records.sumSettledCostMicroUsd(since, "own")).toBe(
      1_000_040,
    );
    expect(await t.records.sumSettledCostMicroUsd(since, "managed")).toBe(
      9_000_000,
    );
    expect(
      await t.records.sumSettledCostMicroUsd("2026-10-14T12:00:00.001Z", "own"),
    ).toBe(0);
  });

  // #361-T04: a record counts under the key it was settled with, whatever the entitlements say now.
  it("counts a record under the key mode corrected on it while it was reserved", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "own");
    await t.records.setKeyMode(job.id, "managed");
    t.setNow("2026-10-14T12:30:00.000Z");
    await t.records.settle(job.id, SETTLED(700));

    const since = "2026-10-14T12:00:00.000Z";
    expect(await t.records.sumSettledCostMicroUsd(since, "managed")).toBe(700);
    expect(await t.records.sumSettledCostMicroUsd(since, "own")).toBe(0);
  });

  // The period of a run is the one it started in, for the count and for the cost alike.
  it("charges the cost of a run to the period it was reserved in, like the count", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "managed");
    t.setNow("2026-10-15T00:00:05.000Z");
    await t.records.settle(job.id, SETTLED(700));

    const nextPeriod = "2026-10-15T00:00:00.000Z";
    expect(await t.records.countByKind(nextPeriod)).toEqual({
      diff: 0,
      dynamic: 0,
    });
    expect(await t.records.sumSettledCostMicroUsd(nextPeriod, "managed")).toBe(
      0,
    );
    const thisPeriod = "2026-10-14T00:00:00.000Z";
    expect(await t.records.countByKind(thisPeriod)).toEqual({
      diff: 1,
      dynamic: 0,
    });
    expect(await t.records.sumSettledCostMicroUsd(thisPeriod, "managed")).toBe(
      700,
    );
  });
});

describe("the page of settled records", () => {
  // #272-T09
  it("is ordered by settlement time and id, after a cursor, and holds neither reserved nor void records", async () => {
    const t = await setup();
    const a = await t.newJob();
    const b = await t.newJob();
    const c = await t.newJob();
    const voided = await t.newJob();
    const waiting = await t.newJob();
    for (const job of [a, b, c, voided, waiting])
      await t.records.reserve(job.id, "own");
    const ids = new Map<string, string>();
    for (const job of [b, c])
      ids.set(job.id, (await t.records.get(job.id))?.id ?? "");
    const idOf = (jobId: string) => ids.get(jobId) ?? "";
    // b and c settle at the same moment, a a minute later: the record id breaks the tie.
    t.setNow("2026-10-14T12:01:00.000Z");
    await t.records.settle(c.id, SETTLED(3));
    await t.records.settle(b.id, SETTLED(2));
    await t.records.settle(voided.id, { state: "void" });
    t.setNow("2026-10-14T12:02:00.000Z");
    await t.records.settle(a.id, SETTLED(1));

    const first = await t.records.pageSettled({ limit: 2 });
    const tied = [b, c]
      .map((job) => job.id)
      .sort((x, y) => (idOf(x) < idOf(y) ? -1 : 1));
    expect(first.records.map((record) => record.jobId)).toEqual(tied);
    const second = await t.records.pageSettled({
      after: first.next,
      limit: 2,
    });
    expect(second.records.map((record) => record.jobId)).toEqual([a.id]);
    const end = await t.records.pageSettled({ after: second.next, limit: 2 });
    expect(end.records).toEqual([]);
    // an empty page keeps the cursor, so a reader can ask again later
    expect(end.next).toEqual(second.next);
  });

  // #272-T09
  it("is stable under inserts: a record settled later shows up after the cursor, none is repeated", async () => {
    const t = await setup();
    const a = await t.newJob();
    const b = await t.newJob();
    for (const job of [a, b]) await t.records.reserve(job.id, "own");
    t.setNow("2026-10-14T12:01:00.000Z");
    await t.records.settle(a.id, SETTLED(1));
    const first = await t.records.pageSettled({ limit: 10 });
    expect(first.records.map((record) => record.jobId)).toEqual([a.id]);

    t.setNow("2026-10-14T12:02:00.000Z");
    await t.records.settle(b.id, SETTLED(2));
    const second = await t.records.pageSettled({
      after: first.next,
      limit: 10,
    });

    expect(second.records.map((record) => record.jobId)).toEqual([b.id]);
  });

  it("reads records with their cost and tokens as numbers", async () => {
    const t = await setup();
    const job = await t.newJob();
    await t.records.reserve(job.id, "managed");
    t.setNow("2026-10-14T12:01:00.000Z");
    await t.records.settle(job.id, SETTLED(12346));

    const page = await t.records.pageSettled({ limit: 10 });

    expect(page.records).toEqual([
      expect.objectContaining({
        costMicroUsd: 12346,
        promptTokens: 1000,
        completionTokens: 100,
        keyMode: "managed",
        settledAt: "2026-10-14T12:01:00.000Z",
      }),
    ]);
    expect(page.next).toEqual({
      settledAt: "2026-10-14T12:01:00.000Z",
      id: page.records[0]?.id,
    });
  });
});

describe("reading the records for the operator API", () => {
  // #278-T02
  it("serves only records settled strictly before the bound", async () => {
    const t = await setup();
    const [a, b, c] = [await t.newJob(), await t.newJob(), await t.newJob()];
    for (const job of [a, b, c]) await t.records.reserve(job.id, "own");
    for (const [job, at] of [
      [a, "2026-10-14T12:00:01.000Z"],
      [b, "2026-10-14T12:00:02.000Z"],
      [c, "2026-10-14T12:00:03.000Z"],
    ] as const) {
      t.setNow(at);
      await t.records.settle(job.id, SETTLED(1));
    }

    const page = await t.records.pageSettled({
      limit: 10,
      settledBefore: "2026-10-14T12:00:03.000Z",
    });

    expect(page.records.map((record) => record.jobId)).toEqual([a.id, b.id]);
  });

  // #278-T08
  it("filters a page on the time of settlement, from included and to excluded", async () => {
    const t = await setup();
    const [a, b, c] = [await t.newJob(), await t.newJob(), await t.newJob()];
    for (const job of [a, b, c]) await t.records.reserve(job.id, "own");
    for (const [job, at] of [
      [a, "2026-10-14T12:00:01.000Z"],
      [b, "2026-10-14T12:00:02.000Z"],
      [c, "2026-10-14T12:00:03.000Z"],
    ] as const) {
      t.setNow(at);
      await t.records.settle(job.id, SETTLED(1));
    }

    const page = await t.records.pageSettled({
      limit: 10,
      from: "2026-10-14T12:00:02.000Z",
      to: "2026-10-14T12:00:03.000Z",
    });

    expect(page.records.map((record) => record.jobId)).toEqual([b.id]);
  });
});

describe("summarizing a period", () => {
  async function seeded() {
    const t = await setup();
    const jobs = [];
    for (let i = 0; i < 7; i += 1)
      jobs.push(await t.newJob(i === 3 ? "dynamic" : "diff"));
    const at = (n: number) => `2026-10-14T12:0${n}:00.000Z`;
    t.setNow(at(1));
    await t.records.reserve(jobs[0]!.id, "own");
    await t.records.reserve(jobs[1]!.id, "managed");
    await t.records.reserve(jobs[2]!.id, "managed");
    await t.records.reserve(jobs[3]!.id, "managed");
    await t.records.reserve(jobs[4]!.id, "managed");
    await t.records.reserve(jobs[5]!.id, "managed");
    t.setNow(at(0));
    await t.records.reserve(jobs[6]!.id, "managed");
    t.setNow(at(2));
    await t.records.settle(jobs[0]!.id, SETTLED(100));
    await t.records.settle(jobs[1]!.id, SETTLED(200));
    await t.records.settle(jobs[2]!.id, SETTLED(null));
    await t.records.settle(jobs[3]!.id, SETTLED(4000));
    await t.records.settle(jobs[4]!.id, { state: "void" });
    // jobs[5] stays reserved; jobs[6] was reserved before the period.
    await t.records.settle(jobs[6]!.id, SETTLED(99999));
    return { t, jobs, at };
  }

  // #278-T05
  it("counts per kind and key mode, sums the known cost and counts the unknown ones apart", async () => {
    const { t, at } = await seeded();

    const groups = await t.records.summarize({ from: at(1), to: at(5) });

    expect(groups).toEqual([
      {
        reviewKind: "diff",
        keyMode: "managed",
        recordCount: 3,
        settledCount: 2,
        knownCostMicroUsd: 200,
        unknownCostCount: 1,
      },
      {
        reviewKind: "diff",
        keyMode: "own",
        recordCount: 1,
        settledCount: 1,
        knownCostMicroUsd: 100,
        unknownCostCount: 0,
      },
      {
        reviewKind: "dynamic",
        keyMode: "managed",
        recordCount: 1,
        settledCount: 1,
        knownCostMicroUsd: 4000,
        unknownCostCount: 0,
      },
    ]);
  });

  // #278-T05
  it("leaves out void records and gives nothing for a period without runs", async () => {
    const { t } = await seeded();

    expect(
      await t.records.summarize({
        from: "2030-01-01T00:00:00.000Z",
        to: "2030-02-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  // #278-T05
  it("dates a run by the time it started, like the count of the limits, and excludes the end of the period", async () => {
    const { t, at } = await seeded();

    const groups = await t.records.summarize({ from: at(0), to: at(1) });

    expect(groups).toEqual([
      expect.objectContaining({
        recordCount: 1,
        settledCount: 1,
        knownCostMicroUsd: 99999,
      }),
    ]);
  });
});
