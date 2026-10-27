// SPDX-License-Identifier: LicenseRef-Proprietary

// What ONE workspace has been told about its balance (table `billing_notifications`; the factory takes the workspace id, see
// ../workspace-scope.ts; ADR 0006, D9; #506; src/billing/README.md, "Balance notifications"). One row for each kind, made by the
// first crossing; a workspace without a row is armed for both. The repository knows nothing about balances or mail: the decision
// is `src/billing/balance-notifications.ts`, which calls it in the transaction that moved the balance, after the balance row's
// lock, so two writers of one workspace never change these rows at the same time. Every write says whether it changed anything.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import type {
  BalanceMailDelivery,
  BalanceNotificationKind,
  BalanceNotificationState,
} from "../balance-state.ts";
import { formatTimestamp } from "../codecs.ts";
import type { BillingNotificationsTable, Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type BalanceNotification = {
  kind: BalanceNotificationKind;
  state: BalanceNotificationState;
  /** When the mail of the last crossing was decided (ISO 8601); null while nothing was mailed. */
  sentAt: string | null;
  delivery: BalanceMailDelivery;
};

export function toBalanceNotification(
  row: Selectable<BillingNotificationsTable>,
): BalanceNotification {
  return {
    kind: row.kind as BalanceNotificationKind,
    state: row.state as BalanceNotificationState,
    sentAt: row.sent_at,
    delivery: row.delivery as BalanceMailDelivery,
  };
}

export type BillingNotificationsRepository = {
  /** The rows that exist, `empty` before `low`. */
  list(): Promise<BalanceNotification[]>;
  /** The row of a kind, or the armed state of a workspace that was never told. */
  get(kind: BalanceNotificationKind): Promise<BalanceNotification>;
  /**
   * The balance dropped into the state: `sent` from now on, with a mail `due` (`delivery: "due"`, `sentAt` now) or without
   * one (`"none"`: a credit landed in the state, or a lower kind that the mail of a higher kind covers). False, and nothing
   * changed, when the kind was `sent` already.
   */
  markSent(
    kind: BalanceNotificationKind,
    delivery: "due" | "none",
  ): Promise<boolean>;
  /**
   * The balance left the state: `armed` again, and a mail that was `due` but not claimed is withdrawn (it would tell the
   * workspace about a state it is out of); one that is `sending` or done stays as it is. False when the kind was not `sent`.
   */
  rearm(kind: BalanceNotificationKind): Promise<boolean>;
};

export function createBillingNotificationsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): BillingNotificationsRepository {
  async function find(kind: BalanceNotificationKind) {
    return db
      .selectFrom("billing_notifications")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("kind", "=", kind)
      .executeTakeFirst();
  }

  return {
    async list() {
      const rows = await db
        .selectFrom("billing_notifications")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("kind")
        .execute();
      return rows.map(toBalanceNotification);
    },

    async get(kind) {
      const row = await find(kind);
      return row === undefined
        ? { kind, state: "armed", sentAt: null, delivery: "none" }
        : toBalanceNotification(row);
    },

    async markSent(kind, delivery) {
      const timestamp = formatTimestamp(now());
      const sentAt = delivery === "due" ? timestamp : null;
      const existing = await find(kind);
      if (existing === undefined) {
        const inserted = await db
          .insertInto("billing_notifications")
          .values({
            workspace_id: workspaceId,
            kind,
            state: "sent",
            sent_at: sentAt,
            delivery,
            updated_at: timestamp,
          })
          .onConflict((conflict) => conflict.doNothing())
          .returning("kind")
          .executeTakeFirst();
        return inserted !== undefined;
      }
      const updated = await db
        .updateTable("billing_notifications")
        .set({
          state: "sent",
          sent_at: sentAt ?? existing.sent_at,
          delivery,
          updated_at: timestamp,
        })
        .where("workspace_id", "=", workspaceId)
        .where("kind", "=", kind)
        .where("state", "=", "armed")
        .returning("kind")
        .executeTakeFirst();
      return updated !== undefined;
    },

    async rearm(kind) {
      const timestamp = formatTimestamp(now());
      const row = await find(kind);
      if (row === undefined || row.state !== "sent") return false;
      const updated = await db
        .updateTable("billing_notifications")
        .set({
          state: "armed",
          delivery: row.delivery === "due" ? "none" : row.delivery,
          updated_at: timestamp,
        })
        .where("workspace_id", "=", workspaceId)
        .where("kind", "=", kind)
        .where("state", "=", "sent")
        .returning("kind")
        .executeTakeFirst();
      return updated !== undefined;
    },
  };
}
