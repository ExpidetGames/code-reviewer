// SPDX-License-Identifier: Apache-2.0

// The usage endpoints of the operator API against a real database (#278): the feed of settled records of every
// workspace, the same for one workspace, and the summary of a period. The credential, the order of the checks and
// the entitlements are in operator-api.integration.test.ts; the format against the contract file is in
// compatibility/operator-api-contract.integration.test.ts.
import { describe, expect, it } from "vitest";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import {
  NotFoundMarker,
  startOperatorApiHarness,
} from "../../src/test-support/operator-api-harness.ts";

const FEED = "/api/operator/v1/usage";
const workspaceFeed = (id: string) => `/api/operator/v1/workspaces/${id}/usage`;
const summaryOf = (id: string) =>
  `/api/operator/v1/workspaces/${id}/usage/summary`;
const UNKNOWN_COST = "/api/operator/v1/usage/unknown-cost";
const OCTOBER = "from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z";

// The harness clock is 2026-10-14T12:00:00.000Z; everything below is well past the safety lag of 60 seconds.
const SETTLED_AT = (second: number) =>
  `2026-10-14T11:00:${String(second).padStart(2, "0")}.000Z`;

type Item = Record<string, unknown>;

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function itemsOf(response: Response): Promise<Item[]> {
  expect(response.status).toBe(200);
  return (await json(response)).items as Item[];
}

describe("the feed of usage records", () => {
  // #278-T01
  it("serves settled records of every workspace in (settledAt, id) order and continues without gaps or repeats", async () => {
    const h = await startOperatorApiHarness();
    const other = await h.addWorkspace("second");
    await h.usage.seed({
      workspaceId: other,
      id: "c",
      settledAt: SETTLED_AT(3),
    });
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "b",
      settledAt: SETTLED_AT(1),
    });
    await h.usage.seed({
      workspaceId: other,
      id: "a",
      settledAt: SETTLED_AT(1),
    });

    const first = await json(await h.call("GET", `${FEED}?limit=2`));
    const second = await json(
      await h.call("GET", `${FEED}?limit=2&after=${String(first.nextCursor)}`),
    );
    const third = await json(
      await h.call("GET", `${FEED}?limit=2&after=${String(second.nextCursor)}`),
    );

    expect((first.items as Item[]).map((item) => item.id)).toEqual(["a", "b"]);
    expect((second.items as Item[]).map((item) => item.id)).toEqual(["c"]);
    expect(third.items).toEqual([]);
    expect(typeof first.nextCursor).toBe("string");
    // An empty page keeps the position, so the reader asks again later from the same place.
    expect(third.nextCursor).toBe(second.nextCursor);
    expect(first).toMatchObject({ version: 1 });
  });

  // #278-T01
  it("says nothing about a position yet when nothing was ever served", async () => {
    const h = await startOperatorApiHarness();

    const response = await h.call("GET", FEED);

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toEqual({
      version: 1,
      items: [],
      nextCursor: null,
    });
  });

  // #278-T01
  it("shows exactly the documented fields of an item, with the unknown ones as null", async () => {
    const h = await startOperatorApiHarness();
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "known",
      reviewKind: "dynamic",
      keyMode: "managed",
      modelTier: "standard",
      costMicroUsd: 12346,
      promptTokens: 1000,
      completionTokens: 100,
      settledAt: SETTLED_AT(1),
    });
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "unknown",
      settledAt: SETTLED_AT(2),
    });

    const items = await itemsOf(await h.call("GET", FEED));

    expect(items[0]).toEqual({
      id: "known",
      workspaceId: h.workspaceId,
      jobId: expect.any(String),
      reviewKind: "dynamic",
      keyMode: "managed",
      modelTier: "standard",
      costMicroUsd: 12346,
      promptTokens: 1000,
      completionTokens: 100,
      settledAt: SETTLED_AT(1),
      reason: null,
    });
    expect(items[1]).toMatchObject({
      id: "unknown",
      modelTier: null,
      costMicroUsd: null,
      promptTokens: null,
      completionTokens: null,
      reason: null,
    });
  });

  // #273-T06
  it("serves the reason of a run that ended with no result, and null for a run that reported", async () => {
    const h = await startOperatorApiHarness();
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "no-result",
      settledAt: SETTLED_AT(1),
      settledReason: "no_result",
    });
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "failed-after-calls",
      costMicroUsd: 3500,
      promptTokens: 300,
      completionTokens: 30,
      settledAt: SETTLED_AT(2),
    });

    const items = await itemsOf(await h.call("GET", FEED));

    expect(items[0]).toMatchObject({
      id: "no-result",
      costMicroUsd: null,
      promptTokens: null,
      reason: "no_result",
    });
    expect(items[1]).toMatchObject({
      id: "failed-after-calls",
      costMicroUsd: 3500,
      reason: null,
    });
  });

  // #278-T02
  it("does not serve a record settled 10 seconds ago, and serves it once the lag has passed", async () => {
    const h = await startOperatorApiHarness();
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "fresh",
      settledAt: "2026-10-14T11:59:50.000Z",
    });

    expect(await itemsOf(await h.call("GET", FEED))).toEqual([]);
    expect(
      await itemsOf(await h.call("GET", workspaceFeed(h.workspaceId))),
    ).toEqual([]);

    // Exactly 60 seconds old is not older than the lag; one millisecond more is.
    h.setNow(new Date("2026-10-14T12:00:50.000Z"));
    expect(await itemsOf(await h.call("GET", FEED))).toEqual([]);
    h.setNow(new Date("2026-10-14T12:00:50.001Z"));
    expect(
      (await itemsOf(await h.call("GET", FEED))).map((item) => item.id),
    ).toEqual(["fresh"]);
    expect(
      (await itemsOf(await h.call("GET", workspaceFeed(h.workspaceId)))).map(
        (item) => item.id,
      ),
    ).toEqual(["fresh"]);
  });

  // #278-T02
  it("loses no record when two settlements commit out of order within the lag", async () => {
    const h = await startOperatorApiHarness();
    const earlier = await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "a",
      state: "reserved",
    });
    const later = await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "b",
      state: "reserved",
    });
    const settle = (jobId: string, iso: string) =>
      createUsageRecordsRepository(
        h.db,
        h.workspaceId,
        () => new Date(iso),
      ).settle(jobId, {
        state: "settled",
        costMicroUsd: 1,
        promptTokens: 1,
        completionTokens: 1,
      });
    // B is stamped later than A but commits first; the reader polls in between.
    h.setNow(new Date("2026-10-14T12:00:10.000Z"));
    await settle(later.jobId, "2026-10-14T12:00:01.000Z");
    const early = await json(await h.call("GET", FEED));
    await settle(earlier.jobId, "2026-10-14T12:00:00.000Z");

    h.setNow(new Date("2026-10-14T12:01:30.000Z"));
    const reader = await h.call(
      "GET",
      early.nextCursor === null
        ? FEED
        : `${FEED}?after=${String(early.nextCursor)}`,
    );

    expect(early.items).toEqual([]);
    expect((await itemsOf(reader)).map((item) => item.id)).toEqual(["a", "b"]);
  });

  // #278-T03
  it("never serves a reserved or a void record", async () => {
    const h = await startOperatorApiHarness();
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "reserved",
      state: "reserved",
    });
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "void",
      state: "void",
    });
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "settled",
      settledAt: SETTLED_AT(1),
    });

    for (const path of [FEED, workspaceFeed(h.workspaceId)])
      expect(
        (await itemsOf(await h.call("GET", path))).map((item) => item.id),
      ).toEqual(["settled"]);
  });

  // #278-T10
  it("shows one item for a job whose completion is repeated", async () => {
    const h = await startOperatorApiHarness();
    const { jobId } = await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "once",
      state: "reserved",
    });
    const settle = (iso: string, cost: number) =>
      createUsageRecordsRepository(
        h.db,
        h.workspaceId,
        () => new Date(iso),
      ).settle(jobId, {
        state: "settled",
        costMicroUsd: cost,
        promptTokens: 1,
        completionTokens: 1,
      });
    await settle("2026-10-14T11:00:00.000Z", 5);
    await settle("2026-10-14T11:30:00.000Z", 999);
    await createUsageRecordsRepository(h.db, h.workspaceId).reserve(
      jobId,
      "managed",
    );

    const items = await itemsOf(await h.call("GET", FEED));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "once",
      costMicroUsd: 5,
      settledAt: "2026-10-14T11:00:00.000Z",
    });
  });
});

describe("the usage of one workspace", () => {
  // #278-T08
  it("serves only the records of that workspace, with the same paging", async () => {
    const h = await startOperatorApiHarness();
    const other = await h.addWorkspace("second");
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "mine-1",
      settledAt: SETTLED_AT(1),
    });
    await h.usage.seed({
      workspaceId: other,
      id: "theirs",
      settledAt: SETTLED_AT(2),
    });
    await h.usage.seed({
      workspaceId: h.workspaceId,
      id: "mine-2",
      settledAt: SETTLED_AT(3),
    });

    const first = await json(
      await h.call("GET", `${workspaceFeed(h.workspaceId)}?limit=1`),
    );
    const second = await json(
      await h.call(
        "GET",
        `${workspaceFeed(h.workspaceId)}?limit=1&after=${String(first.nextCursor)}`,
      ),
    );

    expect((first.items as Item[]).map((item) => item.id)).toEqual(["mine-1"]);
    expect((second.items as Item[]).map((item) => item.id)).toEqual(["mine-2"]);
    expect(
      (await itemsOf(await h.call("GET", workspaceFeed(other)))).map(
        (item) => item.workspaceId,
      ),
    ).toEqual([other]);
  });

  // #278-T08
  it("filters on the time of settlement, from included and to excluded", async () => {
    const h = await startOperatorApiHarness();
    for (const [id, second] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const)
      await h.usage.seed({
        workspaceId: h.workspaceId,
        id,
        settledAt: SETTLED_AT(second),
      });

    const items = await itemsOf(
      await h.call(
        "GET",
        `${workspaceFeed(h.workspaceId)}?from=${SETTLED_AT(2)}&to=${SETTLED_AT(3)}`,
      ),
    );

    expect(items.map((item) => item.id)).toEqual(["b"]);
  });

  // #278-T08
  it("answers an unknown workspace with 404 workspace_not_found", async () => {
    const h = await startOperatorApiHarness();

    for (const path of [
      workspaceFeed("nope"),
      summaryOf("nope"),
      workspaceFeed("a b"),
    ]) {
      const response = await h.call("GET", path);
      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({
        version: 1,
        error: "workspace_not_found",
      });
    }
  });
});

describe("the summary of a period", () => {
  // #397-T10
  it("serves a superseded run with its reason and its cost, and lists such runs apart in the summary", async () => {
    const h = await startOperatorApiHarness();
    const base = {
      workspaceId: h.workspaceId,
      reservedAt: "2026-10-10T08:00:00.000Z",
      keyMode: "managed" as const,
    };
    await h.usage.seed({ ...base, id: "run", costMicroUsd: 100 });
    await h.usage.seed({
      ...base,
      id: "superseded-known",
      settledAt: SETTLED_AT(2),
      costMicroUsd: 40,
      promptTokens: 600,
      completionTokens: 150,
      settledReason: "superseded",
    });
    await h.usage.seed({
      ...base,
      id: "superseded-unknown",
      settledAt: SETTLED_AT(3),
      costMicroUsd: null,
      settledReason: "superseded",
    });

    const items = await itemsOf(await h.call("GET", FEED));
    const summary = await json(
      await h.call("GET", `${summaryOf(h.workspaceId)}?${OCTOBER}`),
    );

    expect(
      items.map((item) => [item.id, item.reason, item.costMicroUsd]),
    ).toEqual([
      ["run", null, 100],
      ["superseded-known", "superseded", 40],
      ["superseded-unknown", "superseded", null],
    ]);
    // Two superseded runs are no runs of the quota; their known cost is in the sum, their unknown cost is counted.
    expect(summary.groups).toEqual([
      {
        reviewKind: "diff",
        keyMode: "managed",
        recordCount: 1,
        settledCount: 1,
        supersededCount: 2,
        knownCostMicroUsd: 140,
        unknownCostCount: 1,
      },
    ]);
  });

  // #278-T05
  it("counts per kind and key mode, sums the known cost, counts the unknown costs apart and leaves out void records", async () => {
    const h = await startOperatorApiHarness();
    const other = await h.addWorkspace("second");
    const at = "2026-10-05T10:00:00.000Z";
    const base = { workspaceId: h.workspaceId, reservedAt: at, settledAt: at };
    await h.usage.seed({ ...base, keyMode: "managed", costMicroUsd: 100 });
    await h.usage.seed({ ...base, keyMode: "managed", costMicroUsd: 250 });
    await h.usage.seed({ ...base, keyMode: "managed", costMicroUsd: null });
    await h.usage.seed({
      ...base,
      keyMode: "own",
      costMicroUsd: 7,
      reviewKind: "dynamic",
    });
    await h.usage.seed({ ...base, keyMode: "managed", state: "reserved" });
    await h.usage.seed({ ...base, keyMode: "managed", state: "void" });
    await h.usage.seed({
      ...base,
      workspaceId: other,
      keyMode: "managed",
      costMicroUsd: 9999,
    });
    await h.usage.seed({
      ...base,
      reservedAt: "2026-09-30T23:59:59.999Z",
      costMicroUsd: 5000,
    });

    const response = await h.call(
      "GET",
      `${summaryOf(h.workspaceId)}?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      version: 1,
      workspaceId: h.workspaceId,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      groups: [
        {
          reviewKind: "diff",
          keyMode: "managed",
          recordCount: 4,
          settledCount: 3,
          supersededCount: 0,
          knownCostMicroUsd: 350,
          unknownCostCount: 1,
        },
        {
          reviewKind: "dynamic",
          keyMode: "own",
          recordCount: 1,
          settledCount: 1,
          supersededCount: 0,
          knownCostMicroUsd: 7,
          unknownCostCount: 0,
        },
      ],
    });
  });

  // #278-T05
  it("answers a period without runs with no groups", async () => {
    const h = await startOperatorApiHarness();

    const body = await json(
      await h.call(
        "GET",
        `${summaryOf(h.workspaceId)}?from=2020-01-01T00:00:00.000Z&to=2020-02-01T00:00:00.000Z`,
      ),
    );

    expect(body.groups).toEqual([]);
  });
});

describe("the count of runs that settled without a known cost", () => {
  // #385-T03
  it("lists one plain integer per workspace and key mode for the period, and nothing else", async () => {
    const h = await startOperatorApiHarness();
    const other = await h.addWorkspace("second");
    const at = "2026-10-05T10:00:00.000Z";
    const base = { reservedAt: at, settledAt: at };
    await h.usage.seed({ ...base, workspaceId: h.workspaceId, keyMode: "own" });
    await h.usage.seed({
      ...base,
      workspaceId: h.workspaceId,
      keyMode: "own",
      reviewKind: "dynamic",
      settledReason: "no_result",
    });
    await h.usage.seed({
      ...base,
      workspaceId: h.workspaceId,
      keyMode: "managed",
      modelTier: "standard",
      promptTokens: 10,
    });
    await h.usage.seed({
      ...base,
      workspaceId: h.workspaceId,
      keyMode: "managed",
      costMicroUsd: 400,
    });
    await h.usage.seed({ ...base, workspaceId: other, keyMode: "managed" });

    const response = await h.call("GET", `${UNKNOWN_COST}?${OCTOBER}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toEqual({
      version: 1,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      counts: [
        { workspaceId: h.workspaceId, keyMode: "managed", unknownCostCount: 1 },
        { workspaceId: h.workspaceId, keyMode: "own", unknownCostCount: 2 },
        { workspaceId: other, keyMode: "managed", unknownCostCount: 1 },
      ].sort((a, b) =>
        a.workspaceId === b.workspaceId
          ? a.keyMode.localeCompare(b.keyMode)
          : a.workspaceId.localeCompare(b.workspaceId),
      ),
      nextAfter: null,
    });
  });

  // #385-T07
  it("counts by the time the run started, the period rule of the summary, with no safety lag", async () => {
    const h = await startOperatorApiHarness();
    // A run that settled a second ago is counted: this is a total, not a position to continue from.
    await h.usage.seed({
      workspaceId: h.workspaceId,
      reservedAt: "2026-10-14T11:59:58.000Z",
      settledAt: "2026-10-14T11:59:59.000Z",
    });
    await h.usage.seed({
      workspaceId: h.workspaceId,
      reservedAt: "2026-09-30T23:59:59.999Z",
      settledAt: "2026-10-14T11:00:00.000Z",
    });

    const body = await json(await h.call("GET", `${UNKNOWN_COST}?${OCTOBER}`));
    const summary = await json(
      await h.call("GET", `${summaryOf(h.workspaceId)}?${OCTOBER}`),
    );

    expect(body.counts).toEqual([
      { workspaceId: h.workspaceId, keyMode: "own", unknownCostCount: 1 },
    ]);
    expect(summary.groups).toMatchObject([{ unknownCostCount: 1 }]);
  });

  // #385-T08
  it("does not change the answer for workspace B when workspace A settles runs without a cost", async () => {
    const h = await startOperatorApiHarness();
    const other = await h.addWorkspace("second");
    await h.usage.seed({ workspaceId: other, keyMode: "managed" });
    const read = async () =>
      (
        (await json(await h.call("GET", `${UNKNOWN_COST}?${OCTOBER}`)))
          .counts as Array<{ workspaceId: string }>
      ).filter((count) => count.workspaceId === other);
    const summaryBefore = await (
      await h.call("GET", `${summaryOf(other)}?${OCTOBER}`)
    ).text();
    const before = await read();

    await h.usage.seed({ workspaceId: h.workspaceId, keyMode: "managed" });
    await h.usage.seed({ workspaceId: h.workspaceId, keyMode: "own" });

    expect(await read()).toEqual(before);
    expect(
      await (await h.call("GET", `${summaryOf(other)}?${OCTOBER}`)).text(),
    ).toBe(summaryBefore);
  });

  // #385-T03
  it("pages whole workspaces by id with nextAfter, null on the last page", async () => {
    const h = await startOperatorApiHarness();
    const ids = [
      h.workspaceId,
      await h.addWorkspace("second"),
      await h.addWorkspace("third"),
    ].sort();
    for (const workspaceId of ids) {
      await h.usage.seed({ workspaceId, keyMode: "own" });
      await h.usage.seed({ workspaceId, keyMode: "managed" });
    }

    const first = await json(
      await h.call("GET", `${UNKNOWN_COST}?${OCTOBER}&limit=2`),
    );
    const second = await json(
      await h.call(
        "GET",
        `${UNKNOWN_COST}?${OCTOBER}&limit=2&after=${String(first.nextAfter)}`,
      ),
    );

    expect((first.counts as Item[]).map((count) => count.workspaceId)).toEqual([
      ids[0],
      ids[0],
      ids[1],
      ids[1],
    ]);
    expect(first.nextAfter).toBe(ids[1]);
    expect((second.counts as Item[]).map((count) => count.workspaceId)).toEqual(
      [ids[2], ids[2]],
    );
    expect(second.nextAfter).toBeNull();
  });

  // #385-T03
  it("answers a period without unknown costs with no counts", async () => {
    const h = await startOperatorApiHarness();
    await h.usage.seed({ workspaceId: h.workspaceId, costMicroUsd: 1 });

    expect(
      await json(await h.call("GET", `${UNKNOWN_COST}?${OCTOBER}`)),
    ).toMatchObject({ counts: [], nextAfter: null });
  });

  // #385-T09
  it.each([
    "",
    "from=2026-10-01T00:00:00.000Z",
    "to=2026-11-01T00:00:00.000Z",
    "from=2026-10-01&to=2026-11-01",
    "from=2026-11-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
  ])("refuses the period %j with period_invalid", async (query) => {
    const h = await startOperatorApiHarness();

    const response = await h.call("GET", `${UNKNOWN_COST}?${query}`);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      version: 1,
      error: "period_invalid",
    });
  });

  // #385-T09
  it.each([
    "limit=0",
    "limit=201",
    "limit=abc",
    "after=",
    "after=not%20an%20id",
  ])("refuses %s with request_invalid", async (query) => {
    const h = await startOperatorApiHarness();

    const response = await h.call("GET", `${UNKNOWN_COST}?${OCTOBER}&${query}`);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      version: 1,
      error: "request_invalid",
    });
  });
});

describe("what a caller may not do", () => {
  // #278-T06
  it.each([
    ["an empty cursor", "after="],
    ["a cursor that is not base64url", "after=not%20a%20cursor"],
    ["an oversized cursor", `after=${"A".repeat(500)}`],
    [
      "a cursor of another shape",
      `after=${Buffer.from("hello").toString("base64url")}`,
    ],
  ])("refuses %s with cursor_invalid on every feed", async (_name, query) => {
    const h = await startOperatorApiHarness();

    for (const path of [FEED, workspaceFeed(h.workspaceId)]) {
      const response = await h.call("GET", `${path}?${query}`);
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        version: 1,
        error: "cursor_invalid",
      });
    }
  });

  // #278-T06
  it.each([
    "limit=0",
    "limit=201",
    "limit=-1",
    "limit=abc",
    "limit=1.5",
    "limit=",
    "limit=99999",
  ])("refuses %s with request_invalid on every feed", async (query) => {
    const h = await startOperatorApiHarness();

    for (const path of [FEED, workspaceFeed(h.workspaceId)]) {
      const response = await h.call("GET", `${path}?${query}`);
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        version: 1,
        error: "request_invalid",
      });
    }
  });

  // #278-T06
  it.each([
    "from=yesterday",
    "to=2026-10-01",
    "from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    "from=2026-10-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
  ])(
    "refuses the period %s of a workspace feed with period_invalid",
    async (query) => {
      const h = await startOperatorApiHarness();

      const response = await h.call(
        "GET",
        `${workspaceFeed(h.workspaceId)}?${query}`,
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        version: 1,
        error: "period_invalid",
      });
    },
  );

  // #278-T06
  it.each([
    "",
    "from=2026-10-01T00:00:00.000Z",
    "to=2026-10-01T00:00:00.000Z",
    "from=2026-10-01&to=2026-11-01",
    "from=2026-11-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
  ])(
    "refuses the period %j of a summary with period_invalid",
    async (query) => {
      const h = await startOperatorApiHarness();

      const response = await h.call(
        "GET",
        `${summaryOf(h.workspaceId)}?${query}`,
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        version: 1,
        error: "period_invalid",
      });
    },
  );

  // #278-T06
  it("offers GET only, and no body on it", async () => {
    const h = await startOperatorApiHarness();

    for (const path of [
      FEED,
      UNKNOWN_COST,
      workspaceFeed(h.workspaceId),
      summaryOf(h.workspaceId),
    ]) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const response = await h.call(method, path, { body: {} });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET");
      }
      const withBody = await h.call("GET", path, { rawBody: "{}" });
      expect(withBody.status).toBe(400);
      expect(await json(withBody)).toMatchObject({ error: "body_not_allowed" });
    }
  });

  // #278-T07
  it("does not exist while the API is off", async () => {
    const h = await startOperatorApiHarness({ token: undefined });

    for (const path of [
      FEED,
      UNKNOWN_COST,
      workspaceFeed(h.workspaceId),
      summaryOf(h.workspaceId),
    ])
      await expect(h.call("GET", path)).rejects.toBeInstanceOf(NotFoundMarker);
    expect(h.lines).toEqual([]);
  });

  // #278-T07
  it("answers a missing or wrong token with 401 before anything else is looked at", async () => {
    const h = await startOperatorApiHarness();

    for (const path of [
      FEED,
      UNKNOWN_COST,
      `${UNKNOWN_COST}?limit=0`,
      workspaceFeed(h.workspaceId),
      summaryOf(h.workspaceId),
      workspaceFeed("nope"),
      `${FEED}?limit=0`,
    ]) {
      for (const options of [
        { token: null },
        { token: "wrong-token-value-0123456789-0123456789" },
      ]) {
        const response = await h.call("GET", path, options);
        expect(response.status).toBe(401);
        expect(await json(response)).toEqual({
          version: 1,
          error: "unauthorized",
        });
      }
    }
  });
});

describe("what the answers and logs leave out", () => {
  // #278-T04
  it("contains no model name, repository, pull request, user or key, in the items, the summary, the count of unknown costs or the logs", async () => {
    const h = await startOperatorApiHarness();
    await h.usage.seed({
      workspaceId: h.workspaceId,
      keyMode: "managed",
      modelTier: "standard",
      costMicroUsd: 5,
      settledAt: SETTLED_AT(1),
      reservedAt: SETTLED_AT(0),
      jobResult: {
        model: "vendor/secret-model-7b",
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.000005 },
        summary: "api key sk-or-v1-0123456789abcdef and mail dev@example.test",
      },
    });
    // A run without a cost, which the count of unknown costs lists.
    await h.usage.seed({
      workspaceId: h.workspaceId,
      keyMode: "managed",
      modelTier: "standard",
      settledAt: SETTLED_AT(2),
      reservedAt: SETTLED_AT(0),
      jobResult: { model: "vendor/secret-model-7b" },
    });
    await h.db
      .insertInto("users")
      .values({
        id: "u1",
        name: "Dana Developer",
        email: "dana@example.test",
        email_verified: 1,
        image: null,
        github_login: "dana-dev",
        imported_at: null,
        is_instance_admin: 0,
        org_checked_at: null,
        org_checked_for: null,
        created_at: SETTLED_AT(0),
        updated_at: SETTLED_AT(0),
      })
      .execute();

    const texts = [
      await (await h.call("GET", FEED)).text(),
      await (await h.call("GET", workspaceFeed(h.workspaceId))).text(),
      await (
        await h.call(
          "GET",
          `${summaryOf(h.workspaceId)}?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`,
        )
      ).text(),
      await (await h.call("GET", `${UNKNOWN_COST}?${OCTOBER}`)).text(),
      ...h.lines,
      ...h.errors,
    ].join("\n");

    expect(texts).toContain("standard");
    for (const secret of [
      "secret-model",
      "vendor/",
      "acme",
      "private-widgets",
      "pull/",
      "octocat",
      "github.test",
      "dana",
      "example.test",
      "sk-or-",
      "0123456789abcdef",
    ])
      expect(texts).not.toContain(secret);
  });
});
