// SPDX-License-Identifier: Apache-2.0

// The mails of balance crossings that are due, for the one process that sends them (#506): instance level on purpose, because
// the sender is told "something is due" and not which workspace, and a workspace's rows are written in the transaction that
// moved its balance. It claims rows (`due` to `sending`, one statement for each row that only one of several racing senders can
// win) and records how a delivery ended; every answer names its workspace, which is where the sender looks up the
// recipients and the balance. The rows themselves are made and changed through the scoped repository.
import "server-only";
import type { Kysely } from "kysely";
import type {
  BalanceNotificationKind,
} from "../../billing/balance-state.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type DueBalanceMail = {
  workspaceId: string;
  kind: BalanceNotificationKind;
};

export type BillingNotificationDirectory = {
  /** Claims up to `limit` due mails, oldest crossing first; each is returned to exactly one caller. */
  claimDue(limit: number): Promise<DueBalanceMail[]>;
  /** Records how the delivery of a claimed mail ended. Only a `sending` mail changes; a repeat changes nothing. */
  finish(
    workspaceId: string,
    kind: BalanceNotificationKind,
    delivery: "delivered" | "failed",
  ): Promise<void>;
};

export function createBillingNotificationDirectory(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): BillingNotificationDirectory {
  return {
    async claimDue(limit) {
      const due = await db
        .selectFrom("billing_notifications")
        .select(["workspace_id", "kind"])
        .where("delivery", "=", "due")
        .orderBy("sent_at")
        .orderBy("workspace_id")
        .orderBy("kind")
        .limit(limit)
        .execute();
      const claimed: DueBalanceMail[] = [];
      for (const row of due) {
        const won = await db
          .updateTable("billing_notifications")
          .set({ delivery: "sending", updated_at: formatTimestamp(now()) })
          .where("workspace_id", "=", row.workspace_id)
          .where("kind", "=", row.kind)
          .where("delivery", "=", "due")
          .returning("kind")
          .executeTakeFirst();
        if (won !== undefined)
          claimed.push({
            workspaceId: row.workspace_id,
            kind: row.kind as BalanceNotificationKind,
          });
      }
      return claimed;
    },

    async finish(workspaceId, kind, delivery) {
      await db
        .updateTable("billing_notifications")
        .set({ delivery, updated_at: formatTimestamp(now()) })
        .where("workspace_id", "=", workspaceId)
        .where("kind", "=", kind)
        .where("delivery", "=", "sending")
        .execute();
    },
  };
}
