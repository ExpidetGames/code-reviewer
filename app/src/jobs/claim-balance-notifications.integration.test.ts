// SPDX-License-Identifier: LicenseRef-Proprietary

// #506: a claim that is refused because the balance is empty tells the workspace once (the decision is made in the claim's
// transaction, the mail goes out after it). On SQLite and, when TEST_DATABASE_URL is set, on Postgres. Made-up rates and the default
// threshold (5 USD) of test-support/billing-switch.ts.
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { deliverDueBalanceMails } from "../billing/balance-mail.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import type { Database } from "../db/schema.ts";
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

describe.each(databases)(
  "the balance notices at the claim on %s",
  (name, open) => {
    const run = name === "Postgres" && open === undefined ? it.skip : it;

    async function start() {
      const database = await open?.();
      const fixture = await createJobQueueFixture({
        ...(database === undefined ? {} : { database }),
        dynamicReview: true,
      });
      await setBillingSwitch(fixture.db, true);
      await insertUser(fixture.db, {
        id: "owner",
        email: "owner@example.test",
      });
      await createWorkspaceMembersRepository(
        fixture.db,
        fixture.workspaceId,
      ).add("owner", "owner");
      return fixture;
    }

    let pr = 300;
    function enqueue(fixture: JobQueueFixture) {
      pr += 1;
      fixture.clock.advance(1);
      return fixture.enqueueNew({ prNumber: pr, reviewKind: "diff" });
    }

    const notifications = (fixture: JobQueueFixture) =>
      createBillingNotificationsRepository(
        fixture.db,
        fixture.workspaceId,
        fixture.clock.now,
      );

    // #506-T04
    run(
      "records the empty crossing when a claim is refused for a balance of zero, once for ten refusals",
      async () => {
        const fixture = await start();
        for (let job = 0; job < 10; job += 1) {
          await enqueue(fixture);
          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
        }

        expect(await notifications(fixture).list()).toEqual([
          expect.objectContaining({
            kind: "empty",
            state: "sent",
            delivery: "due",
          }),
          expect.objectContaining({
            kind: "low",
            state: "sent",
            delivery: "none",
          }),
        ]);
        const mail = createFakeMail();
        await deliverDueBalanceMails({
          db: fixture.db,
          mail,
          baseUrl: "https://reviews.example.com",
          log: () => undefined,
        });
        await deliverDueBalanceMails({
          db: fixture.db,
          mail,
          baseUrl: "https://reviews.example.com",
          log: () => undefined,
        });
        expect(mail.outbox).toHaveLength(1);
        expect(mail.outbox[0]?.subject).toContain("No credit left");
      },
    );

    // #506-T05
    run(
      "mails once when a refund took the balance below zero and the claim that follows is refused",
      async () => {
        const fixture = await start();
        await fundWorkspace(fixture.db, fixture.workspaceId, 10 * USD);
        await createBillingJournalRepository(
          fixture.db,
          fixture.workspaceId,
          fixture.clock.now,
        ).append({
          type: "refund",
          amountMicroUsd: -12 * USD,
          refKey: "re_1",
          provider: "fake",
          providerRef: "re_1",
        });
        await enqueue(fixture);

        expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
        await enqueue(fixture);
        expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

        const mail = createFakeMail();
        await deliverDueBalanceMails({
          db: fixture.db,
          mail,
          baseUrl: "https://reviews.example.com",
          log: () => undefined,
        });
        expect(mail.outbox).toHaveLength(1);
        expect(mail.outbox[0]?.text).toContain("-$2.00");
      },
    );

    // #506-T06
    run(
      "refuses the claim and fails the job the same when the mail server is down, and logs one stable code",
      async () => {
        const fixture = await start();
        const job = await enqueue(fixture);

        expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

        expect(await fixture.queue.get(job.id)).toMatchObject({
          status: "failed",
          errorCode: "insufficient_balance",
        });
        const mail = createFakeMail(false);
        const lines: string[] = [];
        await deliverDueBalanceMails({
          db: fixture.db,
          mail,
          baseUrl: "https://reviews.example.com",
          log: (line) => lines.push(line),
        });
        expect(lines).toEqual([
          `[billing] BALANCE_MAIL_FAILED workspace=${fixture.workspaceId} kind=empty code=not_configured recipients=1`,
        ]);
      },
    );

    // #506-T14
    run(
      "saves the refusal and returns normally from the claim when the notification cannot be written",
      async () => {
        const fixture = await start();
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await failWritesToBalanceNotifications(fixture.db);
          const job = await enqueue(fixture);

          expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

          expect(await fixture.queue.get(job.id)).toMatchObject({
            status: "failed",
            errorCode: "insufficient_balance",
          });
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
    run("records nothing for a refusal while billing is off", async () => {
      const fixture = await start();
      await setBillingSwitch(fixture.db, false);
      await enqueue(fixture);

      await fixture.queue.claimNext("runner-a", ENGINES);

      expect(await notifications(fixture).list()).toEqual([]);
    });
  },
);
