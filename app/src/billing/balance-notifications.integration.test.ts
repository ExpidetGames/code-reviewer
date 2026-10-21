// SPDX-License-Identifier: Apache-2.0

// #506: the decision whether a workspace is told about its balance, on SQLite and on Postgres. The decision is made in the
// transaction of every journal write, under the lock of the balance row: a drop into the low or the empty state arms one mail,
// ten more drops arm none, and a credit that lifts the balance out of the state arms the next. Made-up rates and the default
// threshold (5 USD) of test-support/billing-switch.ts.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationDirectory } from "../db/repositories/billing-notification-directory-repository.ts";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";

const USD = 1_000_000;

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `the balance notifications on ${engine.name}`,
    () => {
      let tick = 0;
      async function start(options: { billing?: boolean } = {}) {
        const { db, workspaceId, otherWorkspaceId } = await engine.create();
        if (options.billing !== false) await setBillingSwitch(db, true);
        const clock = () => new Date(Date.UTC(2026, 9, 21, 8, 0, (tick += 1)));
        const journal = (workspace = workspaceId) =>
          createBillingJournalRepository(db, workspace, clock);
        const notifications = (workspace = workspaceId) =>
          createBillingNotificationsRepository(db, workspace, clock);
        let charges = 0;
        const charge = (microUsd: number, workspace = workspaceId) => {
          charges += 1;
          return journal(workspace).charge(`job-${String(charges)}`, {
            aiMicroUsd: microUsd,
            infraMicroUsd: 0,
            minutes: 1,
            reviewKind: "diff",
          });
        };
        const topUp = (microUsd: number, workspace = workspaceId) =>
          fundWorkspace(db, workspace, microUsd, clock);
        return {
          db,
          workspaceId,
          otherWorkspaceId,
          journal,
          notifications,
          charge,
          topUp,
        };
      }

      async function states(t: Awaited<ReturnType<typeof start>>) {
        const rows = await t.notifications().list();
        return Object.fromEntries(
          rows.map((row) => [row.kind, `${row.state}/${row.delivery}`]),
        );
      }

      // #506-T01
      it("arms one mail when the balance falls below the threshold", async () => {
        const t = await start();
        await t.topUp(10 * USD);
        await t.charge(4 * USD);
        expect(await states(t), "6 USD is not low").toEqual({});

        await t.charge(2 * USD);

        expect(await states(t)).toEqual({ low: "sent/due" });
        expect((await t.notifications().get("low")).sentAt).not.toBeNull();
      });

      // #506-T02
      it("arms no second mail for ten more settlements while the balance stays low", async () => {
        const t = await start();
        await t.topUp(10 * USD);
        await t.charge(6 * USD);
        const first = await t.notifications().get("low");
        const directory = createBillingNotificationDirectory(t.db);
        expect(await directory.claimDue(10)).toEqual([
          { workspaceId: t.workspaceId, kind: "low" },
        ]);
        await directory.finish(t.workspaceId, "low", "delivered");

        for (let run = 0; run < 10; run += 1) await t.charge(100_000);

        expect(await t.notifications().get("low")).toEqual({
          ...first,
          delivery: "delivered",
        });
        expect(await directory.claimDue(10)).toEqual([]);
      });

      // #506-T03
      it("re-arms when a top-up lifts the balance above the threshold, and arms one new mail when it drops again", async () => {
        const t = await start();
        await t.topUp(10 * USD);
        await t.charge(6 * USD);
        const directory = createBillingNotificationDirectory(t.db);
        await directory.claimDue(10);
        await directory.finish(t.workspaceId, "low", "delivered");

        await t.topUp(500_000);
        expect(await states(t), "4.50 USD is still low").toEqual({
          low: "sent/delivered",
        });
        await t.topUp(10 * USD);
        expect(await states(t), "14.50 USD is out of the state").toEqual({
          low: "armed/delivered",
        });
        await t.charge(10 * USD);

        expect(await states(t)).toEqual({ low: "sent/due" });
        expect(await directory.claimDue(10)).toHaveLength(1);
      });

      // #506-T03
      it("withdraws a mail that is not sent yet when the balance is lifted out of the state", async () => {
        const t = await start();
        await t.topUp(10 * USD);
        await t.charge(6 * USD);

        await t.topUp(20 * USD);

        expect(await states(t)).toEqual({ low: "armed/none" });
        expect(
          await createBillingNotificationDirectory(t.db).claimDue(10),
        ).toEqual([]);
      });

      // #506-T05
      it("arms one empty mail, and no low mail next to it, when a balance goes to zero", async () => {
        const t = await start();
        await t.topUp(10 * USD);

        await t.charge(10 * USD);

        expect(await states(t)).toEqual({
          empty: "sent/due",
          low: "sent/none",
        });
      });

      // #506-T05
      it("arms the empty mail once when a refund takes the balance below zero", async () => {
        const t = await start();
        await t.topUp(20 * USD);
        await t.journal().append({
          type: "refund",
          amountMicroUsd: -25 * USD,
          refKey: "re_1",
          provider: "fake",
          providerRef: "re_1",
        });
        await t.journal().append({
          type: "chargeback",
          amountMicroUsd: -1 * USD,
          refKey: "dp_1",
          provider: "fake",
          providerRef: "dp_1",
        });
        await t.charge(1 * USD);

        expect(await states(t)).toEqual({
          empty: "sent/due",
          low: "sent/none",
        });
        expect(
          await createBillingNotificationDirectory(t.db).claimDue(10),
        ).toEqual([{ workspaceId: t.workspaceId, kind: "empty" }]);
      });

      // #506-T05
      it("re-arms the empty state only when the balance is above zero again", async () => {
        const t = await start();
        await t.topUp(5 * USD);
        await t.charge(8 * USD);
        expect(await states(t)).toEqual({ empty: "sent/due", low: "sent/none" });

        await t.topUp(2 * USD);
        expect(await states(t), "still below zero").toEqual({
          empty: "sent/due",
          low: "sent/none",
        });
        await t.topUp(2 * USD);

        expect(await states(t), "1 USD: no longer empty, still low").toEqual({
          empty: "armed/none",
          low: "sent/none",
        });
      });

      // #506-T01
      it("tells a workspace that is credited into the low state nothing: the first mail follows a drop", async () => {
        const t = await start();

        await t.topUp(2 * USD);

        expect(await states(t)).toEqual({ low: "sent/none" });
        await t.charge(2 * USD);
        expect(await states(t)).toEqual({
          empty: "sent/due",
          low: "sent/none",
        });
      });

      // #506-T01
      it("follows the threshold the admin set", async () => {
        const t = await start();
        await setBillingSwitch(t.db, true, {
          factorA: 50_000,
          minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
          diffAiReserveMicroUsd: 150_000,
          lowBalanceMicroUsd: 20 * USD,
        });
        await t.topUp(30 * USD);

        await t.charge(11 * USD);

        expect(await states(t)).toEqual({ low: "sent/due" });
      });

      // #506-T08
      it("writes nothing while billing is off", async () => {
        const t = await start({ billing: false });
        await t.topUp(10 * USD);
        await t.charge(10 * USD);

        expect(await states(t)).toEqual({});
      });

      // #506-T08
      it("writes nothing while the switch is on but billing is not ready", async () => {
        const t = await start({ billing: false });
        await setBillingSwitch(t.db, true, {});
        await t.topUp(10 * USD);
        await t.charge(10 * USD);

        expect(await states(t)).toEqual({});
      });

      // #506-T09
      it("keeps the states of two workspaces apart", async () => {
        const t = await start();
        await t.topUp(10 * USD);
        await t.topUp(10 * USD, t.otherWorkspaceId);

        await t.charge(6 * USD);

        expect(await states(t)).toEqual({ low: "sent/due" });
        expect(await t.notifications(t.otherWorkspaceId).list()).toEqual([]);
      });

      // #506-T02
      it("arms exactly one mail when many settlements race", async () => {
        const t = await start();
        await t.topUp(10 * USD);

        await Promise.all(
          Array.from({ length: 8 }, () => t.charge(1 * USD)),
        );

        expect(await states(t)).toEqual({ low: "sent/due" });
        expect(
          await createBillingNotificationDirectory(t.db).claimDue(10),
        ).toHaveLength(1);
        const balance = await t.journal().balance();
        expect(balance.balanceMicroUsd).toBe(2 * USD);
      });
    },
  );
}
