// SPDX-License-Identifier: Apache-2.0

// The monthly total limit and the hidden hourly brake at claim (#499; ADR 0006, 2.9; src/billing/README.md, "Limits"), on SQLite
// and, when TEST_DATABASE_URL is set, on Postgres. Both act at the claim only, in the claim's transaction, after the
// entitlements and before the balance; a refusal is free (no usage record, no journal entry). Made-up rates
// (test-support/billing-switch.ts): a Diff hold on the workspace's own key is 25 minutes x 13,000 = 325,000 micro-USD, a Dynamic
// hold on the operator's key 5,400,000.
import type { Kysely, KyselyPlugin } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { describeCheck } from "../check-runs/check-text.ts";
import { noticeBody } from "../refusal-notices/notice-text.ts";
import { toRunDetailView, toRunRowView } from "../runs/run-view.ts";
import { CLAIM_CAPS_RETRY_MS } from "../billing/claim-caps.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createBillingWorkspaceSettingsRepository } from "../db/repositories/billing-workspace-settings-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { ClaimRefusal } from "../db/repositories/claim-admission.ts";
import type { Database } from "../db/schema.ts";
import {
  TEST_BILLING_RATES,
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  sha,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import { enqueueInWorkspace } from "../test-support/other-workspace-jobs.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";

const ENGINES = ["pr-agent", "opencode"] as const;
const DIFF_OWN_HOLD = 325_000;
const DYNAMIC_MANAGED_HOLD = 5_400_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

/** Makes every read of the workspace limits fail with the given database error code, while `code` is set. */
function limitsReadFault(state: { code: string | null }): KyselyPlugin {
  return {
    transformQuery: ({ node }) => {
      if (
        state.code !== null &&
        JSON.stringify(node).includes("billing_workspace_settings")
      )
        throw Object.assign(new Error("injected"), { code: state.code });
      return node;
    },
    transformResult: async ({ result }) => result,
  };
}

function entitlements(
  keyMode: "own" | "managed",
  suspended = false,
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended,
    suspensionCode: null,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
  };
}

describe.each(databases)(
  "the monthly limit and the hourly brake at claim on %s",
  (name, open) => {
    const run = name === "Postgres" && open === undefined ? it.skip : it;

    async function start(
      options: {
        onRefused?: (refusal: ClaimRefusal) => void;
        billing?: "on" | "off";
        hourlyReviewLimit?: number;
        monthlyLimitMicroUsd?: number;
        /** The balance every case starts with: large, so the balance is never what refuses. 0: none at all. */
        funding?: number;
        /** Wraps the database so that the read of the workspace limits fails while the fault has a code. */
        fault?: { code: string | null };
      } = {},
    ) {
      const opened =
        options.fault === undefined || open !== undefined
          ? await open?.()
          : (await createTestDatabase()).db;
      const database =
        opened === undefined || options.fault === undefined
          ? opened
          : opened.withPlugin(limitsReadFault(options.fault));
      const fixture = await createJobQueueFixture({
        ...(database === undefined ? {} : { database }),
        dynamicReview: true,
        ...(options.onRefused === undefined
          ? {}
          : { onRefused: options.onRefused }),
      });
      await setBillingSwitch(
        fixture.db,
        options.billing !== "off",
        options.billing === "off"
          ? null
          : {
              ...TEST_BILLING_RATES,
              ...(options.hourlyReviewLimit === undefined
                ? {}
                : { hourlyReviewLimit: options.hourlyReviewLimit }),
            },
      );
      if (options.funding !== 0)
        await fundWorkspace(
          fixture.db,
          fixture.workspaceId,
          options.funding ?? 1_000_000_000,
          fixture.clock.now,
        );
      if (options.monthlyLimitMicroUsd !== undefined)
        await limitsOf(fixture).setMonthlyLimit(
          options.monthlyLimitMicroUsd,
          null,
        );
      return fixture;
    }

    const limitsOf = (fixture: JobQueueFixture, workspaceId?: string) =>
      createBillingWorkspaceSettingsRepository(
        fixture.db,
        workspaceId ?? fixture.workspaceId,
        fixture.clock.now,
      );

    const journalOf = (fixture: JobQueueFixture, workspaceId?: string) =>
      createBillingJournalRepository(
        fixture.db,
        workspaceId ?? fixture.workspaceId,
        fixture.clock.now,
      );

    const usageRecords = (fixture: JobQueueFixture) =>
      fixture.db.selectFrom("usage_records").selectAll().execute();

    let seeded = 0;
    /** A run that ended and was charged `micro` (AI plus infrastructure) at the fixture's now. */
    async function charge(
      fixture: JobQueueFixture,
      micro: number,
      workspaceId?: string,
    ) {
      seeded += 1;
      const journal = journalOf(fixture, workspaceId);
      const jobId = `charged-${String(seeded)}`;
      await journal.reserve(micro, jobId);
      await journal.settle(jobId, {
        aiMicroUsd: Math.floor(micro / 2),
        infraMicroUsd: micro - Math.floor(micro / 2),
        minutes: 3,
        reviewKind: "diff",
      });
    }

    let pr = 100;
    function enqueue(
      fixture: JobQueueFixture,
      reviewKind: "diff" | "dynamic" = "diff",
    ) {
      pr += 1;
      fixture.clock.advance(1);
      return fixture.enqueueNew({ prNumber: pr, reviewKind });
    }

    /** Claims the next job and completes it with a result, as a runner would: the review started and ended. */
    async function startAndEnd(fixture: JobQueueFixture) {
      const job = await enqueue(fixture);
      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
      expect(claimed?.job.id).toBe(job.id);
      await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
        ok: true,
        result: {
          ok: true,
          usage: { promptTokens: 100, completionTokens: 10, costUsd: null },
        },
      });
      return job;
    }

    describe("the monthly total limit", () => {
      // #499-T01
      run(
        "refuses a job when this month's charges plus the hold pass the limit, leaving no record and no entry",
        async () => {
          const refusals: ClaimRefusal[] = [];
          const fixture = await start({
            onRefused: (refusal) => refusals.push(refusal),
            monthlyLimitMicroUsd: 1_000_000,
          });
          await charge(fixture, 700_000);
          const entriesBefore = (
            await journalOf(fixture).entries({ limit: 50 })
          ).entries.length;
          const job = await enqueue(fixture);

          const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

          expect(claimed).toBeNull();
          expect(await fixture.queue.get(job.id)).toMatchObject({
            status: "failed",
            errorCode: "monthly_limit_reached",
            attempts: 0,
            runnerId: null,
          });
          expect(await usageRecords(fixture)).toEqual([]);
          expect(
            (await journalOf(fixture).entries({ limit: 50 })).entries,
          ).toHaveLength(entriesBefore);
          expect(refusals).toEqual([
            expect.objectContaining({
              jobId: job.id,
              workspaceId: fixture.workspaceId,
              errorCode: "monthly_limit_reached",
              periodStart: `head:${job.headSha}`,
            }),
          ]);
        },
      );

      // #499-T02
      run(
        "lets a job pass when the charges plus the hold are exactly the limit",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: 1_000_000,
          });
          await charge(fixture, 1_000_000 - DIFF_OWN_HOLD);
          const job = await enqueue(fixture);

          const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

          expect(claimed?.job.id).toBe(job.id);
          expect(await usageRecords(fixture)).toHaveLength(1);
        },
      );

      // #499-T02
      run("refuses by one micro-USD more than the limit", async () => {
        const fixture = await start({
          monthlyLimitMicroUsd: 1_000_000,
        });
        await charge(fixture, 1_000_000 - DIFF_OWN_HOLD + 1);
        const job = await enqueue(fixture);

        expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
        expect((await fixture.queue.get(job.id))?.errorCode).toBe(
          "monthly_limit_reached",
        );
      });

      // #499-T02
      run(
        "starts the sum again at the first moment of a new UTC month",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: 1_000_000,
          });
          fixture.clock.set(new Date("2026-10-31T23:59:59.000Z"));
          await charge(fixture, 900_000);
          const lastOfOctober = await enqueue(fixture);
          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(lastOfOctober.id))?.errorCode).toBe(
            "monthly_limit_reached",
          );

          fixture.clock.set(new Date("2026-11-01T00:00:00.000Z"));
          const firstOfNovember = await enqueue(fixture);
          const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

          expect(claimed?.job.id).toBe(firstOfNovember.id);
        },
      );

      // #499-T01
      run(
        "counts the hold of the job by its kind and key: a Dynamic job on the operator's key holds more than a small limit",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: DYNAMIC_MANAGED_HOLD - 1,
          });
          await createWorkspaceEntitlementsRepository(
            fixture.db,
            fixture.workspaceId,
            fixture.clock.now,
          ).put(entitlements("managed"), null);
          const dynamic = await enqueue(fixture, "dynamic");

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(dynamic.id))?.errorCode).toBe(
            "monthly_limit_reached",
          );

          await limitsOf(fixture).setMonthlyLimit(DYNAMIC_MANAGED_HOLD, null);
          const again = await enqueue(fixture, "dynamic");
          expect(
            (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
          ).toBe(again.id);
        },
      );

      // #499-T03
      run("never refuses for it when no limit is set", async () => {
        const fixture = await start();
        await charge(fixture, 900_000_000);
        const job = await enqueue(fixture);

        const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

        expect(claimed?.job.id).toBe(job.id);
      });

      // #499-T03
      run("never refuses for it once the limit is cleared", async () => {
        const fixture = await start({ monthlyLimitMicroUsd: 1_000 });
        await charge(fixture, 50_000);
        await limitsOf(fixture).setMonthlyLimit(null, null);
        const job = await enqueue(fixture);

        expect(
          (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
        ).toBe(job.id);
      });

      // #499-T01
      run(
        "is the limit of one workspace and leaves another alone",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: 1_000,
          });
          const refused = await enqueue(fixture);
          fixture.clock.advance(1000);
          const other = await addWorkspace(fixture.db, "other");
          await fundWorkspace(fixture.db, other, 10_000_000, fixture.clock.now);
          const otherJob = await enqueueInWorkspace(fixture, other);

          const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

          expect(claimed?.job).toMatchObject({
            id: otherJob,
            workspaceId: other,
          });
          expect((await fixture.queue.get(refused.id))?.errorCode).toBe(
            "monthly_limit_reached",
          );
        },
      );

      // #499-T01
      run(
        "does not count the charges of another workspace against this one",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: 1_000_000,
          });
          const other = await addWorkspace(fixture.db, "other");
          await fundWorkspace(fixture.db, other, 10_000_000, fixture.clock.now);
          await charge(fixture, 5_000_000, other);
          const job = await enqueue(fixture);

          expect(
            (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
          ).toBe(job.id);
        },
      );

      // #499-T01
      run(
        "counts a charge made earlier in the month, also from an earlier day",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: 1_000_000,
          });
          fixture.clock.set(new Date("2026-10-02T08:00:00.000Z"));
          await charge(fixture, 900_000);
          fixture.clock.set(new Date("2026-10-28T08:00:00.000Z"));
          const job = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(job.id))?.errorCode).toBe(
            "monthly_limit_reached",
          );
        },
      );
    });

    describe("the hourly abuse brake", () => {
      // #499-T05
      run(
        "refuses the review after the limit within an hour, and leaves another workspace alone",
        async () => {
          const refusals: ClaimRefusal[] = [];
          const fixture = await start({
            onRefused: (refusal) => refusals.push(refusal),
            hourlyReviewLimit: 3,
          });
          for (let started = 0; started < 3; started += 1) {
            const job = await enqueue(fixture);
            expect(
              (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
            ).toBe(job.id);
          }
          const fourth = await enqueue(fixture);
          fixture.clock.advance(1000);
          const other = await addWorkspace(fixture.db, "other");
          await fundWorkspace(fixture.db, other, 10_000_000, fixture.clock.now);
          const otherJob = await enqueueInWorkspace(fixture, other);
          const entriesBefore = (
            await journalOf(fixture).entries({ limit: 50 })
          ).entries.length;

          const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

          expect(claimed?.job).toMatchObject({
            id: otherJob,
            workspaceId: other,
          });
          expect(await fixture.queue.get(fourth.id)).toMatchObject({
            status: "failed",
            errorCode: "reviews_paused",
          });
          expect(
            (await usageRecords(fixture)).filter(
              (record) => record.workspace_id === fixture.workspaceId,
            ),
          ).toHaveLength(3);
          expect(
            (await journalOf(fixture).entries({ limit: 50 })).entries,
          ).toHaveLength(entriesBefore);
          expect(refusals).toEqual([
            expect.objectContaining({
              jobId: fourth.id,
              errorCode: "reviews_paused",
              periodStart: `head:${fourth.headSha}`,
            }),
          ]);
        },
      );

      // #499-T13
      run(
        "stores a neutral code for the refused job and shows the customer neither the window, nor the number, nor the code",
        async () => {
          const fixture = await start({ hourlyReviewLimit: 37 });
          for (let started = 0; started < 37; started += 1) {
            fixture.clock.advance(1);
            const old = await fixture.seedHistoricalJob({
              command: "review",
              prNumber: 2_000 + started,
            });
            await createUsageRecordsRepository(
              fixture.db,
              fixture.workspaceId,
              fixture.clock.now,
            ).reserve(old.id, "own");
          }
          const refused = await enqueue(fixture);
          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          const stored = await fixture.queue.get(refused.id);

          expect(stored).toMatchObject({
            status: "failed",
            errorCode: "reviews_paused",
          });
          if (stored === undefined)
            throw new Error("the refused job is missing");
          const check = describeCheck({
            status: "failed",
            errorCode: stored.errorCode,
            commentUrl: null,
            findings: null,
            stoppedEarly: null,
          });
          const detail = toRunDetailView(stored, "p", fixture.clock.now());
          const row = toRunRowView(stored, "p", fixture.clock.now());
          const customerSees = [
            check.title,
            check.summary,
            detail.problem,
            row.problem,
            noticeBody("reviews_paused", `head:${stored.headSha}`, null),
          ].join("\n");

          expect(detail.errorCode).toBeNull();
          expect(customerSees).not.toMatch(/hour|brake|window|minute|\d/i);
          expect(customerSees).not.toContain("reviews_paused");
          expect(JSON.stringify([check, detail, row])).not.toContain(
            "reviews_paused",
          );
          expect(customerSees).toContain("Reviews are paused");
        },
      );

      // #499-T05
      run(
        "lets 60 started reviews of a workspace through in an hour and refuses the 61st when the admin set no number",
        async () => {
          const fixture = await start();
          for (let started = 0; started < 60; started += 1) {
            fixture.clock.advance(1);
            const old = await fixture.seedHistoricalJob({
              command: "review",
              prNumber: 1_000 + started,
            });
            await createUsageRecordsRepository(
              fixture.db,
              fixture.workspaceId,
              fixture.clock.now,
            ).reserve(old.id, "own");
          }
          const sixtyFirst = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(sixtyFirst.id))?.errorCode).toBe(
            "reviews_paused",
          );
        },
      );

      // #499-T05
      run("lets the 60th through when the admin set no number", async () => {
        const fixture = await start();
        for (let started = 0; started < 59; started += 1) {
          fixture.clock.advance(1);
          const old = await fixture.seedHistoricalJob({
            command: "review",
            prNumber: 1_000 + started,
          });
          await createUsageRecordsRepository(
            fixture.db,
            fixture.workspaceId,
            fixture.clock.now,
          ).reserve(old.id, "own");
        }
        const sixtieth = await enqueue(fixture);

        expect(
          (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
        ).toBe(sixtieth.id);
      });

      // #499-T07
      run("does not count reviews started over an hour ago", async () => {
        const fixture = await start({ hourlyReviewLimit: 2 });
        await startAndEnd(fixture);
        await startAndEnd(fixture);
        const startedAt = fixture.clock.now().getTime();

        // A moment before the hour is over, both starts still count ...
        fixture.clock.set(new Date(startedAt + HOUR - 100));
        const insideTheHour = await enqueue(fixture);
        expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
        expect((await fixture.queue.get(insideTheHour.id))?.errorCode).toBe(
          "reviews_paused",
        );

        // ... and over an hour after both, neither does.
        fixture.clock.set(new Date(startedAt + HOUR + 10));
        const afterTheHour = await enqueue(fixture);
        expect(
          (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
        ).toBe(afterTheHour.id);
      });

      // #499-T07
      run(
        "counts a review started exactly an hour ago as outside the window, and one a millisecond younger as inside",
        async () => {
          const fixture = await start({ hourlyReviewLimit: 1 });
          const first = await startAndEnd(fixture);
          const record = await createUsageRecordsRepository(
            fixture.db,
            fixture.workspaceId,
          ).get(first.id);
          const startedAt = Date.parse(record?.reservedAt ?? "");

          // `enqueue` moves the clock on by a millisecond: the claim below is at startedAt + HOUR - 1, inside the window.
          fixture.clock.set(new Date(startedAt + HOUR - 2));
          const inside = await enqueue(fixture);
          expect(fixture.clock.now().getTime()).toBe(startedAt + HOUR - 1);
          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(inside.id))?.errorCode).toBe(
            "reviews_paused",
          );

          // And this one at exactly startedAt + HOUR: the first start is exactly an hour old, so it no longer counts.
          fixture.clock.set(new Date(startedAt + HOUR - 1));
          const outside = await enqueue(fixture);
          expect(fixture.clock.now().getTime()).toBe(startedAt + HOUR);
          expect(
            (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
          ).toBe(outside.id);
        },
      );

      // #499-T05
      run("counts a review that a newer push replaced too", async () => {
        const fixture = await start({ hourlyReviewLimit: 1 });
        const old = await fixture.enqueueNew();
        const claimed = await fixture.queue.claimNext("runner-a", ENGINES, {
          acceptsSupersede: true,
        });
        expect(claimed?.job.id).toBe(old.id);
        fixture.clock.advance(1);
        const newer = await fixture.enqueueNew({ headSha: sha("b") });
        expect((await fixture.queue.get(old.id))?.status).toBe("superseded");

        // The replaced review did start; the one that replaced it is the second start of the hour.
        const answer = await fixture.queue.claimNext("runner-b", ENGINES);

        expect(answer).toBeNull();
        expect((await fixture.queue.get(newer.id))?.errorCode).toBe(
          "reviews_paused",
        );
      });

      // #499-T05
      run(
        "runs a job claimed again after a lost lease although the number is reached, with the one record it has",
        async () => {
          const fixture = await start({ hourlyReviewLimit: 1 });
          const job = await enqueue(fixture);
          expect(
            (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
          ).toBe(job.id);
          fixture.clock.advance(3 * MINUTE);

          const again = await fixture.queue.claimNext("runner-b", ENGINES);

          // The lease ran out: the job is handed out again, and its own start is not counted against it.
          expect(again?.job.id).toBe(job.id);
          expect(await usageRecords(fixture)).toHaveLength(1);
        },
      );

      // #499-T05
      run(
        "lets exactly one of two claims at the same moment take the last start of the hour",
        async () => {
          const fixture = await start({ hourlyReviewLimit: 1 });
          const one = await enqueue(fixture);
          const two = await enqueue(fixture);

          const answers = await Promise.all([
            fixture.queue.claimNext("runner-a", ENGINES),
            fixture.queue.claimNext("runner-b", ENGINES),
          ]);

          expect(answers.filter((answer) => answer !== null)).toHaveLength(1);
          const statuses = await Promise.all(
            [one, two].map(
              async (job) => (await fixture.queue.get(job.id))?.status,
            ),
          );
          expect(statuses.sort()).toEqual(["failed", "running"]);
          expect(await usageRecords(fixture)).toHaveLength(1);
        },
      );
    });

    describe("the order of the checks", () => {
      // #499-T01
      run(
        "checks the entitlements first: a suspended workspace stays suspended",
        async () => {
          const fixture = await start({
            hourlyReviewLimit: 1,
            monthlyLimitMicroUsd: 1,
          });
          await createWorkspaceEntitlementsRepository(
            fixture.db,
            fixture.workspaceId,
            fixture.clock.now,
          ).put(entitlements("own", true), null);
          const job = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(job.id))?.errorCode).toBe(
            "workspace_suspended",
          );
        },
      );

      // #499-T06
      run("checks the brake before the monthly limit", async () => {
        const fixture = await start({
          hourlyReviewLimit: 1,
          monthlyLimitMicroUsd: 1,
        });
        const first = await enqueue(fixture);
        // The monthly limit would refuse the first job as well, so give it room, then tighten it.
        await limitsOf(fixture).setMonthlyLimit(1_000_000_000, null);
        await fixture.queue.claimNext("runner-a", ENGINES);
        await limitsOf(fixture).setMonthlyLimit(1, null);
        const second = await enqueue(fixture);

        expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
        expect((await fixture.queue.get(second.id))?.errorCode).toBe(
          "reviews_paused",
        );
        expect(first.id).not.toBe(second.id);
      });

      // #499-T01
      run(
        "checks the monthly limit before the balance: a workspace over its limit with an empty balance is told about the limit",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: 1,
            funding: 1,
          });
          const job = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(job.id))?.errorCode).toBe(
            "monthly_limit_reached",
          );
        },
      );

      // #499-T01
      run(
        "reaches the balance when the limit has room: an empty balance still refuses",
        async () => {
          const fixture = await start({
            monthlyLimitMicroUsd: 1_000_000_000,
            funding: 0,
          });
          const job = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect((await fixture.queue.get(job.id))?.errorCode).toBe(
            "insufficient_balance",
          );
        },
      );
    });

    describe("billing off", () => {
      // #499-T03
      run(
        "changes nothing while billing is off, whatever a limit or the usage says",
        async () => {
          const fixture = await start({
            billing: "off",
            monthlyLimitMicroUsd: 1,
          });
          for (let started = 0; started < 3; started += 1) {
            const job = await enqueue(fixture);
            expect(
              (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
            ).toBe(job.id);
          }
        },
      );

      // #499-T03
      run(
        "reads no billing table of the workspace while billing is off",
        async () => {
          const fixture = await start({ billing: "off" });
          await sql`alter table billing_workspace_settings rename to settings_gone`.execute(
            fixture.db,
          );
          const job = await enqueue(fixture);

          expect(
            (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
          ).toBe(job.id);
        },
      );
    });

    describe("the start credit", () => {
      const STARTER_RATES = {
        ...TEST_BILLING_RATES,
        startCreditMicroUsd: 2_000_000,
      };

      /** A workspace that meets billing for the first time: no balance, an installation of a GitHub account, a start credit set. */
      async function newcomer(limits: {
        hourlyReviewLimit: number;
        monthlyLimitMicroUsd?: number;
      }) {
        const fixture = await start({ funding: 0 });
        await setBillingSwitch(fixture.db, true, {
          ...STARTER_RATES,
          hourlyReviewLimit: limits.hourlyReviewLimit,
        });
        await createIntegrationsRepository(
          fixture.db,
          fixture.workspaceId,
          fixture.clock.now,
        ).create({
          type: "github_app",
          displayName: "starter",
          externalId: "7777",
          config: {
            accountLogin: "starter",
            accountType: "User",
            accountId: 9001,
          },
        });
        if (limits.monthlyLimitMicroUsd !== undefined)
          await limitsOf(fixture).setMonthlyLimit(
            limits.monthlyLimitMicroUsd,
            null,
          );
        return fixture;
      }

      const startCredits = async (fixture: JobQueueFixture) =>
        (await journalOf(fixture).entries({ limit: 50 })).entries.filter(
          (entry) => entry.type === "start_credit",
        );
      const grants = (fixture: JobQueueFixture) =>
        fixture.db
          .selectFrom("billing_start_credit_grants")
          .selectAll()
          .execute();

      // #499-T17
      run(
        "grants the start credit to a job the limits let through (the control of the next two cases)",
        async () => {
          const fixture = await newcomer({ hourlyReviewLimit: 60 });
          const job = await enqueue(fixture);

          expect(
            (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
          ).toBe(job.id);
          expect(await startCredits(fixture)).toHaveLength(1);
          expect(await grants(fixture)).toHaveLength(1);
        },
      );

      // #499-T17
      run(
        "grants no start credit to a job the hidden brake refused: no entry, no journal change, no grant row",
        async () => {
          const fixture = await newcomer({ hourlyReviewLimit: 1 });
          fixture.clock.advance(1);
          const old = await fixture.seedHistoricalJob({
            command: "review",
            prNumber: 3_000,
          });
          await createUsageRecordsRepository(
            fixture.db,
            fixture.workspaceId,
            fixture.clock.now,
          ).reserve(old.id, "own");
          const job = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

          expect((await fixture.queue.get(job.id))?.errorCode).toBe(
            "reviews_paused",
          );
          expect(
            (await journalOf(fixture).entries({ limit: 50 })).entries,
          ).toEqual([]);
          expect(await grants(fixture)).toEqual([]);
        },
      );

      // #499-T17
      run(
        "grants no start credit to a job the monthly limit refused: no entry, no journal change, no grant row",
        async () => {
          const fixture = await newcomer({
            hourlyReviewLimit: 60,
            monthlyLimitMicroUsd: 1,
          });
          const job = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

          expect((await fixture.queue.get(job.id))?.errorCode).toBe(
            "monthly_limit_reached",
          );
          expect(
            (await journalOf(fixture).entries({ limit: 50 })).entries,
          ).toEqual([]);
          expect(await grants(fixture)).toEqual([]);
        },
      );
    });

    describe("a limit that cannot be evaluated for now", () => {
      for (const code of ["40P01", "SQLITE_BUSY"])
        // #499-T15
        run(
          `leaves the job queued for a later claim, counts an attempt and goes on, when the read fails with ${code}`,
          async () => {
            const refusals: ClaimRefusal[] = [];
            const fault = { code: code as string | null };
            const fixture = await start({
              fault,
              onRefused: (refusal) => refusals.push(refusal),
            });
            const first = await enqueue(fixture);
            const second = await enqueue(fixture);
            const entriesBefore = (
              await journalOf(fixture).entries({ limit: 50 })
            ).entries.length;
            const failedAt = fixture.clock.now().getTime();

            // The pass ends: a struggling database is not asked again in the same transaction.
            expect(
              await fixture.queue.claimNext("runner-a", ENGINES),
            ).toBeNull();

            expect(await fixture.queue.get(first.id)).toMatchObject({
              status: "queued",
              errorCode: null,
              attempts: 1,
              runnerId: null,
              runAfter: new Date(failedAt + CLAIM_CAPS_RETRY_MS).toISOString(),
            });
            expect(await fixture.queue.get(second.id)).toMatchObject({
              status: "queued",
              attempts: 0,
            });
            expect(await usageRecords(fixture)).toEqual([]);
            expect(
              (await journalOf(fixture).entries({ limit: 50 })).entries,
            ).toHaveLength(entriesBefore);
            expect(refusals).toEqual([]);

            // The database is well again: the next job goes first, the deferred one is not at the head until it is due ...
            fault.code = null;
            expect(
              (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
            ).toBe(second.id);
            // ... and then it is claimed like any other.
            fixture.clock.advance(CLAIM_CAPS_RETRY_MS);
            expect(
              (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
            ).toBe(first.id);
          },
        );

      // #499-T16
      run(
        "fails the job closed once its attempts are used up, like a lost lease, and reports the refusal once",
        async () => {
          const refusals: ClaimRefusal[] = [];
          const fault = { code: "57014" as string | null };
          const fixture = await start({
            fault,
            onRefused: (refusal) => refusals.push(refusal),
          });
          const job = await enqueue(fixture);

          for (let attempt = 1; attempt <= 2; attempt += 1) {
            expect(
              await fixture.queue.claimNext("runner-a", ENGINES),
            ).toBeNull();
            expect(await fixture.queue.get(job.id)).toMatchObject({
              status: "queued",
              attempts: attempt,
            });
            fixture.clock.advance(CLAIM_CAPS_RETRY_MS);
          }
          expect(refusals).toEqual([]);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

          expect(await fixture.queue.get(job.id)).toMatchObject({
            status: "failed",
            errorCode: "billing_limits_unreadable",
          });
          expect(refusals).toEqual([
            expect.objectContaining({
              jobId: job.id,
              errorCode: "billing_limits_unreadable",
            }),
          ]);
          expect(await usageRecords(fixture)).toEqual([]);
        },
      );

      // #499-T16
      run(
        "does not touch the attempts of a job whose limits can be read again before it is due",
        async () => {
          const fault = { code: "40001" as string | null };
          const fixture = await start({ fault });
          const job = await enqueue(fixture);
          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          fault.code = null;

          // Not due yet: nothing is claimed and nothing changes.
          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
          expect(await fixture.queue.get(job.id)).toMatchObject({
            status: "queued",
            attempts: 1,
          });
        },
      );
    });

    describe("a limit that cannot be evaluated", () => {
      // #499-T01
      run(
        "fails closed for the job with a stable code and never throws out of the claim",
        async () => {
          const fixture = await start();
          await sql`alter table billing_workspace_settings rename to settings_gone`.execute(
            fixture.db,
          );
          const first = await enqueue(fixture);
          const second = await enqueue(fixture);

          const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

          // Both were refused in the same transaction: a failed statement did not poison it.
          expect(claimed).toBeNull();
          expect((await fixture.queue.get(first.id))?.errorCode).toBe(
            "billing_limits_unreadable",
          );
          expect((await fixture.queue.get(second.id))?.errorCode).toBe(
            "billing_limits_unreadable",
          );
          expect(await usageRecords(fixture)).toEqual([]);

          // The table is back: the queue works again.
          await sql`alter table settings_gone rename to billing_workspace_settings`.execute(
            fixture.db,
          );
          const third = await enqueue(fixture);
          expect(
            (await fixture.queue.claimNext("runner-a", ENGINES))?.job.id,
          ).toBe(third.id);
        },
      );
    });
  },
);
