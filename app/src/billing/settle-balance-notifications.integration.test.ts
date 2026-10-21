// SPDX-License-Identifier: Apache-2.0

// #506: the settlement of a finished job is where most crossings happen. The charge is written and the decision that the workspace is
// to be told is made in the same transaction; a mail server that is down changes neither. On SQLite and, when TEST_DATABASE_URL is set,
// on Postgres. Made-up rates (test-support/billing-switch.ts) and the default threshold (5 USD).
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import type { Database } from "../db/schema.ts";
import type { JobOutcome } from "../jobs/job-types.ts";
import { createLlmKeyModeStore } from "../llm/key-mode-store.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { failWritesToBalanceNotifications } from "../test-support/failing-notifications.ts";
import { createFakeMail } from "../test-support/fake-mail.ts";
import {
  createJobQueueFixture,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { deliverDueBalanceMails } from "./balance-mail.ts";

const ENGINES = ["pr-agent", "opencode"] as const;
const USD = 1_000_000;

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

const delivered = (costUsd: number): JobOutcome => ({
  ok: true,
  result: {
    ok: true,
    usage: { promptTokens: 100, completionTokens: 10, costUsd, aiCalls: 1 },
  },
});

describe.each(databases)("the notices at a settlement on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function start(funding: number) {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
    });
    await setBillingSwitch(fixture.db, true);
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
    await createLlmKeyModeStore(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).set("managed", null);
    await insertUser(fixture.db, { id: "owner", email: "owner@example.test" });
    await createWorkspaceMembersRepository(fixture.db, fixture.workspaceId).add(
      "owner",
      "owner",
    );
    await fundWorkspace(
      fixture.db,
      fixture.workspaceId,
      funding,
      fixture.clock.now,
    );
    return fixture;
  }

  let pr = 500;
  async function finishJob(fixture: JobQueueFixture, costUsd: number) {
    pr += 1;
    fixture.clock.advance(1);
    const job = await fixture.enqueueNew({ prNumber: pr, reviewKind: "diff" });
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    if (claimed === null || claimed.job.id !== job.id)
      throw new Error("The job was not claimed.");
    fixture.clock.advance(60_000);
    await fixture.queue.complete(
      job.id,
      claimed.leaseToken,
      delivered(costUsd),
    );
  }

  const notifications = (fixture: JobQueueFixture) =>
    createBillingNotificationsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
  const balanceOf = async (fixture: JobQueueFixture) =>
    (
      await createBillingJournalRepository(
        fixture.db,
        fixture.workspaceId,
        fixture.clock.now,
      ).balance()
    ).balanceMicroUsd;
  const deliver = (fixture: JobQueueFixture, mail = createFakeMail()) => {
    const lines: string[] = [];
    return {
      mail,
      lines,
      run: () =>
        deliverDueBalanceMails({
          db: fixture.db,
          mail,
          baseUrl: "https://reviews.example.com",
          log: (line) => lines.push(line),
        }),
    };
  };

  // #506-T01
  run(
    "decides in the settlement that the balance fell below the threshold, and mails it once",
    async () => {
      const fixture = await start(6 * USD);
      await finishJob(fixture, 0.5);

      expect(await balanceOf(fixture)).toBeLessThan(5 * USD);
      expect(await notifications(fixture).list()).toEqual([
        expect.objectContaining({ kind: "low", delivery: "due" }),
      ]);
      const sender = deliver(fixture);
      await sender.run();
      expect(sender.mail.outbox).toHaveLength(1);
      expect(sender.mail.outbox[0]?.to).toBe("owner@example.test");
    },
  );

  // #506-T02
  run(
    "mails nothing more for ten more settlements while the balance is low",
    async () => {
      const fixture = await start(6 * USD);
      await finishJob(fixture, 0.5);
      const sender = deliver(fixture);
      await sender.run();

      for (let job = 0; job < 10; job += 1) await finishJob(fixture, 0.001);
      await sender.run();

      expect(sender.mail.outbox).toHaveLength(1);
      expect(await notifications(fixture).list()).toEqual([
        expect.objectContaining({ kind: "low", delivery: "delivered" }),
      ]);
    },
  );

  // #506-T05
  run(
    "mails the empty state once when a charge takes the balance below zero",
    async () => {
      const fixture = await start(1 * USD);
      await finishJob(fixture, 0.5);

      expect(await balanceOf(fixture)).toBeLessThan(0);
      const sender = deliver(fixture);
      await sender.run();
      await finishJob(fixture, 0).catch(() => undefined);
      await sender.run();

      expect(sender.mail.outbox).toHaveLength(1);
      expect(sender.mail.outbox[0]?.subject).toContain("No credit left");
    },
  );

  // #506-T06
  run(
    "commits the charge and the job's end however the mail server behaves, and logs one stable code",
    async () => {
      const fixture = await start(6 * USD);
      await finishJob(fixture, 0.5);
      const balance = await balanceOf(fixture);
      const sender = deliver(fixture, createFakeMail(false));

      await sender.run();

      expect(await balanceOf(fixture)).toBe(balance);
      expect(sender.lines).toEqual([
        `[billing] BALANCE_MAIL_FAILED workspace=${fixture.workspaceId} kind=low code=not_configured recipients=1`,
      ]);
      expect(await notifications(fixture).list()).toEqual([
        expect.objectContaining({ kind: "low", delivery: "failed" }),
      ]);
    },
  );

  // #506-T12
  run(
    "commits the charge and the job's end when the notification cannot be written, and skips the notification",
    async () => {
      const fixture = await start(6 * USD);
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await failWritesToBalanceNotifications(fixture.db);
        pr += 1;
        fixture.clock.advance(1);
        const job = await fixture.enqueueNew({
          prNumber: pr,
          reviewKind: "diff",
        });
        const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
        if (claimed === null) throw new Error("The job was not claimed.");
        fixture.clock.advance(60_000);

        await fixture.queue.complete(
          job.id,
          claimed.leaseToken,
          delivered(0.5),
        );

        expect(await fixture.queue.get(job.id)).toMatchObject({
          status: "succeeded",
        });
        expect(await balanceOf(fixture)).toBeLessThan(5 * USD);
        expect(await notifications(fixture).list()).toEqual([]);
        expect(warnings.mock.calls).toEqual([
          [
            `[billing] BALANCE_NOTE_FAILED workspace=${fixture.workspaceId} code=note_failed`,
          ],
        ]);
      } finally {
        warnings.mockRestore();
      }
    },
  );

  // #506-T08
  run(
    "decides nothing for a job that ended while billing was off",
    async () => {
      const fixture = await start(6 * USD);
      await setBillingSwitch(fixture.db, false);
      await finishJob(fixture, 0.5);

      expect(await notifications(fixture).list()).toEqual([]);
    },
  );
});
