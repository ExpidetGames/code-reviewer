// SPDX-License-Identifier: Apache-2.0

// #506: the decision whether a workspace is told about its balance is a side effect of every money write and must never undo one.
// A trigger makes every write to `billing_notifications` fail (test-support/failing-notifications.ts); the charge, the credit and
// the refund still commit, the notification is skipped and one stable line is logged (no address, no text of the database).
// On SQLite and, when TEST_DATABASE_URL is set, on Postgres.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { failWritesToBalanceNotifications } from "../test-support/failing-notifications.ts";

const USD = 1_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `a failing balance notification on ${engine.name}`,
    () => {
      let tick = 0;
      async function start() {
        const { db, workspaceId } = await engine.create();
        await setBillingSwitch(db, true);
        const clock = () => new Date(Date.UTC(2026, 9, 21, 9, 0, (tick += 1)));
        const journal = createBillingJournalRepository(db, workspaceId, clock);
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          clock,
        );
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
        await fundWorkspace(db, workspaceId, 10 * USD, clock);
        return { db, workspaceId, journal, notifications, warnings };
      }

      const noteFailedLine = (workspaceId: string) =>
        `[billing] BALANCE_NOTE_FAILED workspace=${workspaceId} code=note_failed`;

      // #506-T11
      it("commits a charge that takes the balance below the threshold and skips the notification", async () => {
        const t = await start();
        await failWritesToBalanceNotifications(t.db);

        const charged = await t.journal.charge("job-1", {
          aiMicroUsd: 6 * USD,
          infraMicroUsd: 0,
          minutes: 1,
          reviewKind: "diff",
        });

        expect(charged.created).toBe(true);
        expect((await t.journal.balance()).balanceMicroUsd).toBe(4 * USD);
        expect(await t.notifications.list()).toEqual([]);
        expect(t.warnings.mock.calls).toEqual([
          [noteFailedLine(t.workspaceId)],
        ]);
      });

      // #506-T11
      it("commits a credit when re-arming a state fails, and a refund that empties the balance", async () => {
        const t = await start();
        await t.journal.charge("job-1", {
          aiMicroUsd: 6 * USD,
          infraMicroUsd: 0,
          minutes: 1,
          reviewKind: "diff",
        });
        expect(await t.notifications.list()).toHaveLength(1);
        await failWritesToBalanceNotifications(t.db);

        await fundWorkspace(t.db, t.workspaceId, 10 * USD);
        await t.journal.append({
          type: "refund",
          amountMicroUsd: -20 * USD,
          refKey: "re_1",
          provider: "fake",
          providerRef: "re_1",
        });

        expect((await t.journal.balance()).balanceMicroUsd).toBe(-6 * USD);
        expect(await t.notifications.get("low")).toMatchObject({
          state: "sent",
        });
        expect(t.warnings.mock.calls).toEqual([
          [noteFailedLine(t.workspaceId)],
          [noteFailedLine(t.workspaceId)],
        ]);
      });

      // #506-T11
      it("logs nothing the database said and no address", async () => {
        const t = await start();
        await failWritesToBalanceNotifications(t.db);

        await t.journal.charge("job-1", {
          aiMicroUsd: 6 * USD,
          infraMicroUsd: 0,
          minutes: 1,
          reviewKind: "diff",
        });

        expect(JSON.stringify(t.warnings.mock.calls)).not.toContain("injected");
      });
    },
  );
}
