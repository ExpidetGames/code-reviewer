// SPDX-License-Identifier: LicenseRef-Proprietary

// #506: what a workspace has been told about its balance (the scoped repository) and the claim of the mails that are due
// (the instance level directory), on SQLite and on Postgres.
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";
import { createBillingNotificationDirectory } from "./billing-notification-directory-repository.ts";
import { createBillingNotificationsRepository } from "./billing-notifications-repository.ts";

const AT = new Date("2026-10-21T08:00:00.000Z");

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(
    `the billing notifications on ${engine.name}`,
    () => {
      // #506-T09
      it("has no row before anything was told, and a workspace is armed without one", async () => {
        const { db, workspaceId } = await engine.create();
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          () => AT,
        );

        expect(await notifications.list()).toEqual([]);
        expect(await notifications.get("low")).toEqual({
          kind: "low",
          state: "armed",
          sentAt: null,
          delivery: "none",
        });
      });

      // #506-T09
      it("records a crossing with its mail, and a second one for the same kind changes nothing", async () => {
        const { db, workspaceId } = await engine.create();
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          () => AT,
        );

        expect(await notifications.markSent("empty", "due")).toBe(true);
        expect(await notifications.markSent("empty", "due")).toBe(false);

        expect(await notifications.get("empty")).toEqual({
          kind: "empty",
          state: "sent",
          sentAt: AT.toISOString(),
          delivery: "due",
        });
        expect((await notifications.get("low")).state).toBe("armed");
      });

      // #506-T09
      it("records a crossing that is not mailed without a time", async () => {
        const { db, workspaceId } = await engine.create();
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          () => AT,
        );

        await notifications.markSent("low", "none");

        expect(await notifications.get("low")).toEqual({
          kind: "low",
          state: "sent",
          sentAt: null,
          delivery: "none",
        });
      });

      // #506-T03
      it("re-arms a kind, withdraws a mail that was not sent yet and keeps one that is on its way", async () => {
        const { db, workspaceId } = await engine.create();
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          () => AT,
        );
        await notifications.markSent("low", "due");
        await notifications.markSent("empty", "due");
        await createBillingNotificationDirectory(db, () => AT).claimDue(10);

        await notifications.rearm("low");
        await notifications.rearm("empty");

        expect(await notifications.list()).toEqual([
          expect.objectContaining({ kind: "empty", state: "armed" }),
          expect.objectContaining({ kind: "low", state: "armed" }),
        ]);
        // Both mails were claimed (`sending`) before the re-arm: nothing is taken back from a sender.
        expect((await notifications.get("low")).delivery).toBe("sending");
        expect(await notifications.rearm("low")).toBe(false);
      });

      // #506-T03
      it("withdraws a mail that is due when the balance leaves the state first", async () => {
        const { db, workspaceId } = await engine.create();
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          () => AT,
        );
        await notifications.markSent("low", "due");

        expect(await notifications.rearm("low")).toBe(true);

        expect((await notifications.get("low")).delivery).toBe("none");
        expect(
          await createBillingNotificationDirectory(db, () => AT).claimDue(10),
        ).toEqual([]);
      });

      // #506-T02
      it("lets one of two racing senders claim a mail", async () => {
        const { db, workspaceId } = await engine.create();
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          () => AT,
        );
        await notifications.markSent("empty", "due");
        const directory = createBillingNotificationDirectory(db, () => AT);

        const claims = await Promise.all([
          directory.claimDue(10),
          directory.claimDue(10),
          directory.claimDue(10),
        ]);

        expect(claims.flat()).toEqual([{ workspaceId, kind: "empty" }]);
      });

      // #506-T06
      it("records how the delivery ended, once", async () => {
        const { db, workspaceId } = await engine.create();
        const notifications = createBillingNotificationsRepository(
          db,
          workspaceId,
          () => AT,
        );
        await notifications.markSent("empty", "due");
        const directory = createBillingNotificationDirectory(db, () => AT);
        await directory.claimDue(10);

        await directory.finish(workspaceId, "empty", "failed");
        await directory.finish(workspaceId, "empty", "delivered");

        expect((await notifications.get("empty")).delivery).toBe("failed");
        expect(await directory.claimDue(10)).toEqual([]);
      });

      it("claims at most the number asked for, oldest first", async () => {
        const { db, workspaceId, otherWorkspaceId } = await engine.create();
        let tick = 0;
        const clock = () => new Date(AT.getTime() + (tick += 1000));
        await createBillingNotificationsRepository(
          db,
          otherWorkspaceId,
          clock,
        ).markSent("empty", "due");
        await createBillingNotificationsRepository(
          db,
          workspaceId,
          clock,
        ).markSent("empty", "due");
        const directory = createBillingNotificationDirectory(db, clock);

        expect(await directory.claimDue(1)).toEqual([
          { workspaceId: otherWorkspaceId, kind: "empty" },
        ]);
        expect(await directory.claimDue(1)).toEqual([
          { workspaceId, kind: "empty" },
        ]);
        expect(await directory.claimDue(1)).toEqual([]);
      });
    },
  );
}
