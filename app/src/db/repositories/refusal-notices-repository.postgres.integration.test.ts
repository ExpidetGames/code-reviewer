// SPDX-License-Identifier: Apache-2.0

// The record of the notices of refused reviews on Postgres behaves like the SQLite one (#281-T08): one statement
// takes the notice of a pull request and period, so several app instances at once get exactly one, a failed notice
// is taken again only after its wait and up to its attempts, and the checks of the table refuse the same direct
// writes. Runs only when TEST_DATABASE_URL is set.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { createRefusalNoticesRepository } from "./refusal-notices-repository.ts";
import { listDueRefusalNotices } from "./refusal-notices-sweep.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

const MINUTE = 60 * 1000;
const PERIOD = "2026-10-01T00:00:00.000Z";

/** Direct writes that the checks of the table must refuse, whatever the engine. */
const REFUSED_UPDATES = [
  ["a state the code does not know", "state = 'lost'"],
  ["a code the code does not know", "code = 'entitlements_invalid'"],
  ["a posted notice without its time", "state = 'posted'"],
  [
    "a time on a notice that is not posted",
    "posted_at = '2026-10-01T00:00:00.000Z'",
  ],
  ["a negative attempt count", "attempts = -1"],
] as const;

async function setup() {
  const postgres = await createPostgresTestDatabase({ poolMax: 12 });
  const fixture = await createJobQueueFixture({ database: postgres.db });
  let now = new Date("2026-10-14T12:00:00.000Z");
  const notices = createRefusalNoticesRepository(
    fixture.db,
    fixture.workspaceId,
    () => now,
  );
  const key = {
    repositoryId: fixture.repositoryId,
    prNumber: 7,
    periodStart: PERIOD,
  };
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

describePostgres("the refusal notices on Postgres", () => {
  // #281-T08
  it("hands the pull request and period to one of several concurrent callers", async () => {
    const t = await setup();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        t.notices.begin(t.key, "quota_exhausted", {
          leaseMs: 2 * MINUTE,
          maxAttempts: 3,
        }),
      ),
    );

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  // #281-T06
  it("takes a failed notice again only after its wait and up to its attempts, and lists it when due", async () => {
    const t = await setup();
    const options = { leaseMs: 2 * MINUTE, maxAttempts: 2 };
    const first = await t.notices.begin(t.key, "workspace_suspended", options);
    if (!first.acquired) throw new Error("expected the notice");
    await t.notices.failed(
      first.notice.id,
      new Date(t.now().getTime() + 5 * MINUTE),
    );

    t.advance(4 * MINUTE);
    expect(
      (await t.notices.begin(t.key, "workspace_suspended", options)).acquired,
    ).toBe(false);
    expect(
      await listDueRefusalNotices(t.db, t.now(), { limit: 10, maxAttempts: 2 }),
    ).toEqual([]);

    t.advance(2 * MINUTE);
    expect(
      await listDueRefusalNotices(t.db, t.now(), { limit: 10, maxAttempts: 2 }),
    ).toHaveLength(1);
    expect(
      await t.notices.begin(t.key, "workspace_suspended", options),
    ).toMatchObject({
      acquired: true,
      notice: { attempts: 2 },
    });

    t.advance(60 * MINUTE);
    expect(
      (await t.notices.begin(t.key, "workspace_suspended", options)).acquired,
    ).toBe(false);
  });

  // #281-T02
  it("never takes a posted notice again", async () => {
    const t = await setup();
    const options = { leaseMs: MINUTE, maxAttempts: 3 };
    const taken = await t.notices.begin(t.key, "quota_exhausted", options);
    if (!taken.acquired) throw new Error("expected the notice");

    await t.notices.markPosted(taken.notice.id);
    t.advance(60 * MINUTE);

    expect(
      (await t.notices.begin(t.key, "quota_exhausted", options)).acquired,
    ).toBe(false);
    expect(await t.notices.find(t.key)).toMatchObject({ state: "posted" });
  });

  it.each(REFUSED_UPDATES)(
    "refuses a direct write of %s",
    async (_name, assignment) => {
      const t = await setup();
      await t.notices.begin(t.key, "quota_exhausted", {
        leaseMs: MINUTE,
        maxAttempts: 3,
      });

      await expect(
        sql`update refusal_notices set ${sql.raw(assignment)}`.execute(t.db),
      ).rejects.toThrow();
    },
  );
});
