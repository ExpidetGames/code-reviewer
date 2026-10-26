// SPDX-License-Identifier: LicenseRef-Proprietary

// The record of the notices of refused reviews of a workspace against a real Postgres database (#281): one row per pull
// request and period, taken once, retried a bounded number of times, and never changed once posted. Isolation
// between workspaces is in scoped-isolation.integration.test.ts; the notice itself is in
// src/refusal-notices/service.integration.test.ts.
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { createRefusalNoticesRepository } from "./refusal-notices-repository.ts";
import { listDueRefusalNotices } from "./refusal-notices-sweep.ts";

const MINUTE = 60 * 1000;
const PERIOD = "2026-10-01T00:00:00.000Z";

async function setup() {
  const fixture = await createJobQueueFixture();
  let now = new Date("2026-10-14T12:00:00.000Z");
  const notices = createRefusalNoticesRepository(
    fixture.db,
    fixture.workspaceId,
    () => now,
  );
  const key = (
    overrides: Partial<{ prNumber: number; periodStart: string }> = {},
  ) => ({
    repositoryId: fixture.repositoryId,
    prNumber: 7,
    periodStart: PERIOD,
    ...overrides,
  });
  return {
    ...fixture,
    notices,
    key,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

describe("taking a notice", () => {
  // #281-T02
  it("hands the pull request and period to the first caller only", async () => {
    const t = await setup();

    const first = await t.notices.begin(t.key(), "quota_exhausted", {
      leaseMs: 2 * MINUTE,
      maxAttempts: 3,
    });
    const second = await t.notices.begin(t.key(), "quota_exhausted", {
      leaseMs: 2 * MINUTE,
      maxAttempts: 3,
    });

    expect(first).toMatchObject({
      acquired: true,
      notice: {
        workspaceId: t.workspaceId,
        repositoryId: t.repositoryId,
        prNumber: 7,
        periodStart: PERIOD,
        code: "quota_exhausted",
        state: "pending",
        attempts: 1,
        postedAt: null,
      },
    });
    expect(second).toEqual({ acquired: false });
  });

  // #281-T08
  it("lets exactly one of several concurrent callers take it", async () => {
    const t = await setup();

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.notices.begin(t.key(), "workspace_suspended", {
          leaseMs: 2 * MINUTE,
          maxAttempts: 3,
        }),
      ),
    );

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  // #281-T03
  it("treats a later period start, another pull request and another repository as new", async () => {
    const t = await setup();
    const take = (key: ReturnType<typeof t.key>) =>
      t.notices.begin(key, "quota_exhausted", {
        leaseMs: MINUTE,
        maxAttempts: 3,
      });

    expect((await take(t.key())).acquired).toBe(true);
    expect(
      (await take(t.key({ periodStart: "2026-11-01T00:00:00.000Z" }))).acquired,
    ).toBe(true);
    expect((await take(t.key({ prNumber: 8 }))).acquired).toBe(true);
    expect(
      (await take({ ...t.key(), repositoryId: t.otherRepositoryId })).acquired,
    ).toBe(true);
    expect((await take(t.key())).acquired).toBe(false);
  });
});

describe("a notice that was not posted", () => {
  // #281-T06
  it("can be taken again only after its wait, and only up to the attempts", async () => {
    const t = await setup();
    const options = { leaseMs: 2 * MINUTE, maxAttempts: 2 };
    const first = await t.notices.begin(t.key(), "quota_exhausted", options);
    if (!first.acquired) throw new Error("expected the notice");
    await t.notices.failed(
      first.notice.id,
      new Date(t.now().getTime() + 5 * MINUTE),
    );

    // Within the wait nobody takes it.
    t.advance(4 * MINUTE);
    expect(
      (await t.notices.begin(t.key(), "quota_exhausted", options)).acquired,
    ).toBe(false);

    // After the wait the second (and last) attempt is allowed.
    t.advance(2 * MINUTE);
    const retried = await t.notices.begin(t.key(), "quota_exhausted", options);
    expect(retried).toMatchObject({ acquired: true, notice: { attempts: 2 } });
    if (!retried.acquired) throw new Error("expected the notice");
    await t.notices.failed(
      retried.notice.id,
      new Date(t.now().getTime() + MINUTE),
    );

    // No third attempt, however long it waits.
    t.advance(60 * MINUTE);
    expect(
      (await t.notices.begin(t.key(), "quota_exhausted", options)).acquired,
    ).toBe(false);
    expect(await t.notices.find(t.key())).toMatchObject({
      state: "pending",
      attempts: 2,
    });
  });

  // #281-T08
  it("is not taken while the attempt that holds it is in flight, and is after the lease ended", async () => {
    const t = await setup();
    const options = { leaseMs: 2 * MINUTE, maxAttempts: 3 };
    await t.notices.begin(t.key(), "quota_exhausted", options);

    t.advance(MINUTE);
    expect(
      (await t.notices.begin(t.key(), "quota_exhausted", options)).acquired,
    ).toBe(false);

    t.advance(2 * MINUTE);
    expect(
      await t.notices.begin(t.key(), "quota_exhausted", options),
    ).toMatchObject({
      acquired: true,
      notice: { attempts: 2 },
    });
  });
});

describe("a notice that was posted or dropped", () => {
  // #281-T02
  it("is never taken again and keeps its time", async () => {
    const t = await setup();
    const options = { leaseMs: MINUTE, maxAttempts: 3 };
    const taken = await t.notices.begin(t.key(), "quota_exhausted", options);
    if (!taken.acquired) throw new Error("expected the notice");

    await t.notices.markPosted(taken.notice.id);
    t.advance(60 * MINUTE);

    expect(
      (await t.notices.begin(t.key(), "quota_exhausted", options)).acquired,
    ).toBe(false);
    expect(await t.notices.find(t.key())).toMatchObject({
      state: "posted",
      postedAt: "2026-10-14T12:00:00.000Z",
    });
  });

  // #281-T07
  it("is never taken again once dropped", async () => {
    const t = await setup();
    const options = { leaseMs: MINUTE, maxAttempts: 3 };
    const taken = await t.notices.begin(t.key(), "quota_exhausted", options);
    if (!taken.acquired) throw new Error("expected the notice");

    await t.notices.markDropped(taken.notice.id);
    t.advance(60 * MINUTE);

    expect(
      (await t.notices.begin(t.key(), "quota_exhausted", options)).acquired,
    ).toBe(false);
    expect(await t.notices.find(t.key())).toMatchObject({
      state: "dropped",
      postedAt: null,
    });
  });

  it("is not moved back to pending by a failure that arrives late", async () => {
    const t = await setup();
    const taken = await t.notices.begin(t.key(), "quota_exhausted", {
      leaseMs: MINUTE,
      maxAttempts: 3,
    });
    if (!taken.acquired) throw new Error("expected the notice");
    await t.notices.markPosted(taken.notice.id);

    await t.notices.failed(
      taken.notice.id,
      new Date(t.now().getTime() + MINUTE),
    );

    expect(await t.notices.find(t.key())).toMatchObject({ state: "posted" });
  });
});

describe("the notices that are due again", () => {
  // #281-T06
  it("lists the pending ones whose wait is over, oldest first, within the attempts and the limit", async () => {
    const t = await setup();
    const options = { leaseMs: MINUTE, maxAttempts: 2 };
    for (const prNumber of [7, 8, 9, 10]) {
      await t.notices.begin(t.key({ prNumber }), "quota_exhausted", options);
      t.advance(1000);
    }
    const posted = await t.notices.find(t.key({ prNumber: 8 }));
    if (posted === undefined) throw new Error("expected the notice");
    await t.notices.markPosted(posted.id);
    // Not due yet: its lease is still running.
    expect(
      await listDueRefusalNotices(t.db, t.now(), { limit: 10, maxAttempts: 2 }),
    ).toEqual([]);

    t.advance(2 * MINUTE);
    const due = await listDueRefusalNotices(t.db, t.now(), {
      limit: 2,
      maxAttempts: 2,
    });

    expect(due.map((notice) => notice.prNumber)).toEqual([7, 9]);
    expect(due[0]).toMatchObject({
      workspaceId: t.workspaceId,
      repositoryId: t.repositoryId,
      periodStart: PERIOD,
      code: "quota_exhausted",
    });
  });

  it("leaves out a notice that used all its attempts", async () => {
    const t = await setup();
    const options = { leaseMs: MINUTE, maxAttempts: 1 };
    await t.notices.begin(t.key(), "quota_exhausted", options);
    t.advance(5 * MINUTE);

    expect(
      await listDueRefusalNotices(t.db, t.now(), { limit: 10, maxAttempts: 1 }),
    ).toEqual([]);
  });
});
