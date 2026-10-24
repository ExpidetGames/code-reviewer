// SPDX-License-Identifier: LicenseRef-Proprietary

// The instance level page of settled usage records (the feed of the operator API) against a real SQLite file:
// the order across workspaces, the bound of the safety lag and the hazard that the bound exists for.
// The API on top is in integration-tests/http/operator-api-usage.integration.test.ts.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createUsageSeeder } from "../../test-support/usage-seed.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import { createUsageFeedRepository } from "./usage-feed-repository.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const first = await defaultWorkspaceId(db);
  const second = await addWorkspace(db, "second");
  return {
    db,
    first,
    second,
    seeder: createUsageSeeder(db),
    feed: createUsageFeedRepository(db),
  };
}

describe("the feed of settled records of every workspace", () => {
  // #278-T01
  it("orders by time of settlement then id, across workspaces, and continues from the cursor without gaps or repeats", async () => {
    const t = await setup();
    await t.seeder.seed({
      workspaceId: t.second,
      id: "c",
      settledAt: "2026-10-14T12:00:02.000Z",
    });
    await t.seeder.seed({
      workspaceId: t.first,
      id: "b",
      settledAt: "2026-10-14T12:00:01.000Z",
    });
    await t.seeder.seed({
      workspaceId: t.second,
      id: "a",
      settledAt: "2026-10-14T12:00:01.000Z",
    });
    await t.seeder.seed({
      workspaceId: t.first,
      id: "d",
      settledAt: "2026-10-14T12:00:03.000Z",
    });

    const first = await t.feed.pageSettled({ limit: 3 });
    const second = await t.feed.pageSettled({ after: first.next, limit: 3 });
    const third = await t.feed.pageSettled({ after: second.next, limit: 3 });

    expect(first.records.map((record) => record.id)).toEqual(["a", "b", "c"]);
    expect(first.records.map((record) => record.workspaceId)).toEqual([
      t.second,
      t.first,
      t.second,
    ]);
    expect(second.records.map((record) => record.id)).toEqual(["d"]);
    expect(third.records).toEqual([]);
    expect(third.next).toEqual(second.next);
  });

  // #278-T03
  it("never serves a reserved or a void record", async () => {
    const t = await setup();
    await t.seeder.seed({
      workspaceId: t.first,
      id: "reserved",
      state: "reserved",
    });
    await t.seeder.seed({ workspaceId: t.first, id: "void", state: "void" });
    await t.seeder.seed({ workspaceId: t.first, id: "settled" });

    const page = await t.feed.pageSettled({ limit: 10 });

    expect(page.records.map((record) => record.id)).toEqual(["settled"]);
  });

  // #278-T02
  it("serves only records settled strictly before the bound", async () => {
    const t = await setup();
    await t.seeder.seed({
      workspaceId: t.first,
      id: "old",
      settledAt: "2026-10-14T12:00:00.000Z",
    });
    await t.seeder.seed({
      workspaceId: t.first,
      id: "edge",
      settledAt: "2026-10-14T12:00:30.000Z",
    });
    await t.seeder.seed({
      workspaceId: t.first,
      id: "new",
      settledAt: "2026-10-14T12:00:50.000Z",
    });

    const page = await t.feed.pageSettled({
      limit: 10,
      settledBefore: "2026-10-14T12:00:30.000Z",
    });

    expect(page.records.map((record) => record.id)).toEqual(["old"]);
  });
});

describe("two settlements committed out of order", () => {
  /**
   * B is stamped one second after A, but A commits last (a transaction that took its time). `repository` stamps
   * with the clock it is given, so the order of commits is the order of the calls.
   */
  async function outOfOrder() {
    const t = await setup();
    const jobs = [];
    for (const id of ["a", "b"])
      jobs.push(
        await t.seeder.seed({ workspaceId: t.first, id, state: "reserved" }),
      );
    const stamped = (iso: string) =>
      createUsageRecordsRepository(t.db, t.first, () => new Date(iso));
    const settle = (jobId: string, iso: string) =>
      stamped(iso).settle(jobId, {
        state: "settled",
        costMicroUsd: 1,
        promptTokens: 1,
        completionTokens: 1,
      });
    return { ...t, jobs, settle };
  }

  // #278-T02
  it("is missed by a reader that moved past it when nothing bounds the page (the hazard the lag is for)", async () => {
    const t = await outOfOrder();
    await t.settle(t.jobs[1]!.jobId, "2026-10-14T12:00:01.000Z");
    const early = await t.feed.pageSettled({ limit: 10 });
    expect(early.records.map((record) => record.id)).toEqual(["b"]);

    await t.settle(t.jobs[0]!.jobId, "2026-10-14T12:00:00.000Z");
    const later = await t.feed.pageSettled({ after: early.next, limit: 10 });

    expect(later.records).toEqual([]);
  });

  // #278-T02
  it("is not missed by a reader that only reads what is older than the lag, as long as it commits within the lag", async () => {
    const t = await outOfOrder();
    const lag = 60_000;
    const readAt = (iso: string) =>
      new Date(new Date(iso).getTime() - lag).toISOString();
    await t.settle(t.jobs[1]!.jobId, "2026-10-14T12:00:01.000Z");
    const early = await t.feed.pageSettled({
      limit: 10,
      settledBefore: readAt("2026-10-14T12:00:10.000Z"),
    });
    expect(early.records).toEqual([]);

    await t.settle(t.jobs[0]!.jobId, "2026-10-14T12:00:00.000Z");
    const later = await t.feed.pageSettled({
      after: early.next,
      limit: 10,
      settledBefore: readAt("2026-10-14T12:01:30.000Z"),
    });

    expect(later.records.map((record) => record.id)).toEqual(["a", "b"]);
  });
});
