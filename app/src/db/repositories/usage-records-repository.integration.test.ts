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
      await t.records.sumSettledManagedCostMicroUsd("2026-10-14T12:00:00.000Z"),
    ).toBe(1_500_250);
    expect(
      await t.records.sumSettledManagedCostMicroUsd("2026-10-14T12:30:00.001Z"),
    ).toBe(0);
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
