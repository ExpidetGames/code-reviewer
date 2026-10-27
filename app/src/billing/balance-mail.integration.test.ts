// SPDX-License-Identifier: LicenseRef-Proprietary

// #506: the delivery of the balance mails, with the fake mail sender (no real mail is sent): who
// gets one (Owners and Admins, never Members), what it says, that a failing mail server fails nothing but the delivery itself,
// and that one crossing is mailed once however many deliveries run.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createFakeMail } from "../test-support/fake-mail.ts";
import { afterQueryPlugin } from "../test-support/query-hook.ts";
import { insertUser } from "../test-support/users.ts";
import { markWorkspaceDeleted } from "../test-support/workspaces.ts";
import { deliverDueBalanceMails } from "./balance-mail.ts";

const USD = 1_000_000;
const BASE_URL = "https://reviews.example.com";

for (const engine of BILLING_ENGINES) {
  describe(`the balance mails on ${engine.name}`, () => {
    async function start() {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      await setBillingSwitch(db, true);
      const members = createWorkspaceMembersRepository(db, workspaceId);
      for (const [id, role] of [
        ["owner", "owner"],
        ["admin", "admin"],
        ["member", "member"],
      ] as const) {
        await insertUser(db, { id, email: `${id}@example.test` });
        await members.add(id, role);
      }
      const mail = createFakeMail();
      const logged: string[] = [];
      const deliver = () =>
        deliverDueBalanceMails({
          db,
          mail,
          baseUrl: BASE_URL,
          log: (line) => logged.push(line),
        });
      const journal = createBillingJournalRepository(db, workspaceId);
      let charges = 0;
      const charge = (microUsd: number) => {
        charges += 1;
        return journal.charge(`job-${String(charges)}`, {
          aiMicroUsd: microUsd,
          infraMicroUsd: 0,
          minutes: 1,
          reviewKind: "diff",
        });
      };
      return {
        db,
        workspaceId,
        otherWorkspaceId,
        mail,
        logged,
        deliver,
        charge,
        topUp: (microUsd: number) => fundWorkspace(db, workspaceId, microUsd),
        notifications: createBillingNotificationsRepository(db, workspaceId),
      };
    }

    // #506-T01
    it("sends the low mail to each Owner and Admin and to no Member", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);

      await t.deliver();

      expect(t.mail.outbox.map((message) => message.to).sort()).toEqual([
        "admin@example.test",
        "owner@example.test",
      ]);
      const message = t.mail.to("owner@example.test")[0]!;
      expect(message.subject).toBe('Low balance in "billing-a"');
      expect(message.text).toContain("$4.00");
      expect(message.text).toContain(
        `${BASE_URL}/w/billing-a/settings/billing`,
      );
      expect((await t.notifications.get("low")).delivery).toBe("delivered");
    });

    // #506-T02
    it("sends nothing more for ten more settlements, and nothing at a second delivery", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      await t.deliver();
      for (let run = 0; run < 10; run += 1) await t.charge(100_000);

      await t.deliver();
      await t.deliver();

      expect(t.mail.outbox).toHaveLength(2);
    });

    // #506-T02
    it("sends one mail to each recipient when deliveries race", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);

      await Promise.all([t.deliver(), t.deliver(), t.deliver()]);

      expect(t.mail.outbox).toHaveLength(2);
    });

    // #506-T15
    it("sends one mail to each recipient when two deliveries both saw the crossing as due before either claimed it", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      // Each delivery is held after its read of the due crossings until the other has read them too, so both hold the same
      // candidate and only the guard of the claim (`delivery = 'due'`) decides which of them sends.
      let arrived = 0;
      let release: () => void = () => undefined;
      const both = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rendezvous = afterQueryPlugin(async (query) => {
        if (query.kind !== "select" || query.table !== "billing_notifications")
          return;
        arrived += 1;
        if (arrived >= 2) release();
        await Promise.race([both, new Promise((r) => setTimeout(r, 2_000))]);
      });
      const run = () =>
        deliverDueBalanceMails({
          db: t.db.withPlugin(rendezvous),
          mail: t.mail,
          baseUrl: BASE_URL,
          log: (line) => t.logged.push(line),
        });

      const results = await Promise.all([run(), run()]);

      expect(arrived).toBe(2);
      expect(t.mail.outbox).toHaveLength(2);
      expect(results.map((result) => result.delivered).sort()).toEqual([0, 1]);
    });

    // #506-T03
    it("sends a new mail after a top-up lifted the balance and it dropped again", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      await t.deliver();
      await t.topUp(20 * USD);
      await t.charge(20 * USD);

      await t.deliver();

      expect(t.mail.to("owner@example.test")).toHaveLength(2);
      expect(t.mail.to("owner@example.test")[1]!.text).toContain("$4.00");
    });

    // #506-T04
    it("sends the empty mail when the balance reaches zero", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(10 * USD);

      await t.deliver();

      const messages = t.mail.to("admin@example.test");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toBe('No credit left in "billing-a"');
      expect(messages[0]!.text).toContain("$0.00");
    });

    // #506-T05
    it("sends the empty mail once, with the negative balance, when a charge takes it below zero", async () => {
      const t = await start();
      await t.topUp(1 * USD);
      await t.charge(2_500_000);

      await t.deliver();

      const messages = t.mail.to("owner@example.test");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toContain("-$1.50");
      expect(messages[0]!.text).toContain("below zero");
    });

    // #506-T06
    it("records a failing mail server with a stable code and no address, and sends nothing twice", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      t.mail.failNext(2);

      const result = await t.deliver();

      expect(result).toEqual({ delivered: 0, failed: 1 });
      expect((await t.notifications.get("low")).delivery).toBe("failed");
      expect(t.logged).toHaveLength(1);
      expect(t.logged[0]).toMatch(
        /^\[billing\] BALANCE_MAIL_FAILED workspace=\S+ kind=low code=mail_failed recipients=2$/,
      );
      expect(t.logged[0]).not.toContain("@");
      await t.deliver();
      expect(t.mail.outbox).toHaveLength(0);
    });

    // #506-T06
    it("counts a crossing delivered when one recipient was reached", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      t.mail.failNext();

      const result = await t.deliver();

      expect(result).toEqual({ delivered: 1, failed: 0 });
      expect(t.mail.outbox).toHaveLength(1);
      expect(t.logged).toEqual([]);
    });

    // #506-T06
    it("names the instance without a mail server as the stable code not_configured", async () => {
      const t = await start();
      t.mail.configured = false;
      await t.topUp(10 * USD);
      await t.charge(6 * USD);

      await t.deliver();

      expect(t.logged[0]).toContain("code=not_configured");
      expect((await t.notifications.get("low")).delivery).toBe("failed");
    });

    // #506-T06
    it("does not mail a crossing whose workspace has no Owner or Admin", async () => {
      const t = await start();
      await createWorkspaceMembersRepository(t.db, t.workspaceId).remove(
        "owner",
      );
      await createWorkspaceMembersRepository(t.db, t.workspaceId).remove(
        "admin",
      );
      await t.topUp(10 * USD);
      await t.charge(6 * USD);

      await t.deliver();

      expect(t.mail.outbox).toEqual([]);
      expect(t.logged[0]).toContain("code=no_recipients");
    });

    // #658-T04
    it("skips a crossing of a workspace that was deleted meanwhile without a word: no mail, no failure line, the crossing is closed", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      await markWorkspaceDeleted(t.db, t.workspaceId);

      const result = await t.deliver();

      expect(t.mail.outbox).toEqual([]);
      expect(t.logged).toEqual([]);
      expect(result).toEqual({ delivered: 0, failed: 0 });
      expect((await t.notifications.get("low")).delivery).not.toBe("due");
      expect((await t.notifications.get("low")).delivery).not.toBe("sending");
    });

    // #658-T04
    it("does not leave a crossing due for a workspace that is deleted when its balance moves", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await markWorkspaceDeleted(t.db, t.workspaceId);
      await t.db
        .deleteFrom("billing_notifications")
        .where("workspace_id", "=", t.workspaceId)
        .execute();

      await t.charge(6 * USD);
      await t.deliver();

      expect(
        await t.db
          .selectFrom("billing_notifications")
          .selectAll()
          .where("workspace_id", "=", t.workspaceId)
          .execute(),
      ).toEqual([]);
      expect(t.mail.outbox).toEqual([]);
      expect(t.logged).toEqual([]);
    });

    // #506-T07
    it("names no rate, formula, model or provider, and only the balance of its own workspace", async () => {
      const t = await start();
      await fundWorkspace(t.db, t.otherWorkspaceId, 777 * USD);
      await t.topUp(10 * USD);
      await t.charge(10 * USD);

      await t.deliver();

      for (const message of t.mail.outbox)
        for (const body of [
          message.subject,
          message.text,
          message.html ?? "",
        ]) {
          // The other workspace's balance as a number of its own, not as a piece of a random id in a link (#714).
          expect(body).not.toMatch(/(?<![0-9A-Za-z])777(?![0-9A-Za-z])/);
          expect(body).not.toMatch(
            /\b(rate|rates|factor|formula|model|provider|stripe|anthropic|brake|minute|minutes)\b/i,
          );
        }
    });

    // #506-T08
    it("sends nothing while billing is off, even for a crossing that was recorded before", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      await setBillingSwitch(t.db, false);

      const result = await t.deliver();

      expect(result).toEqual({ delivered: 0, failed: 0 });
      expect(t.mail.outbox).toEqual([]);
    });

    // #506-T06
    it("does not tell a workspace that is out of the state again by the time the mail is sent", async () => {
      const t = await start();
      await t.topUp(10 * USD);
      await t.charge(6 * USD);
      // The balance was lifted between the decision and the delivery (the cache is set directly: no journal write ran).
      await t.db
        .updateTable("billing_balances")
        .set({ balance_micro_usd: 50 * USD })
        .execute();

      const result = await t.deliver();

      expect(result).toEqual({ delivered: 0, failed: 1 });
      expect(t.mail.outbox).toEqual([]);
      expect(t.logged[0]).toContain("code=stale");
    });
  });
}
