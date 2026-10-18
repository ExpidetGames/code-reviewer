// SPDX-License-Identifier: Apache-2.0

// The checkouts of ONE workspace (`billing_checkouts`; the factory takes the workspace id, see ../workspace-scope.ts; #441, ADR 0005,
// 2.12). A row says: this server created this Paddle transaction for this workspace to buy this plan version in this interval. It is
// written by the checkout (#443) and read by the webhook, and it is the only link from a Paddle subscription to a workspace: what
// the customer's browser or the payload says about a workspace is never believed on its own.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { BillingCheckoutsTable, Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  BILLING_INTERVALS,
  type BillingInterval,
} from "../../billing/subscription-state.ts";
import type { PaddleEnv } from "./billing-plan-prices-repository.ts";

export type NewCheckout = {
  env: PaddleEnv;
  transactionId: string;
  planVersionId: string;
  billingInterval: BillingInterval;
};

export type CheckoutRow = NewCheckout & {
  id: string;
  workspaceId: string;
  createdAt: string;
};

export type BillingCheckoutsRepository = {
  /** Records a transaction the server created. A transaction id is recorded once per environment (the unique index refuses a second). */
  create(input: NewCheckout): Promise<CheckoutRow>;
  getByTransaction(
    env: PaddleEnv,
    transactionId: string,
  ): Promise<CheckoutRow | undefined>;
};

function toCheckout(row: Selectable<BillingCheckoutsTable>): CheckoutRow {
  const interval = BILLING_INTERVALS.find(
    (value) => value === row.billing_interval,
  );
  if (interval === undefined)
    throw new Error(`Billing checkout ${row.id} has an unknown value.`);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    env: row.paddle_env === "live" ? "live" : "sandbox",
    transactionId: row.transaction_id,
    planVersionId: row.plan_version_id,
    billingInterval: interval,
    createdAt: row.created_at,
  };
}

export function createBillingCheckoutsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => `bchk_${randomUUID().replaceAll("-", "")}`,
): BillingCheckoutsRepository {
  return {
    async create(input) {
      const id = newId();
      await db
        .insertInto("billing_checkouts")
        .values({
          id,
          workspace_id: workspaceId,
          paddle_env: input.env,
          transaction_id: input.transactionId,
          plan_version_id: input.planVersionId,
          billing_interval: input.billingInterval,
          created_at: formatTimestamp(now()),
        })
        .execute();
      const stored = await db
        .selectFrom("billing_checkouts")
        .selectAll()
        .where("id", "=", id)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      return toCheckout(stored);
    },

    async getByTransaction(env, transactionId) {
      const row = await db
        .selectFrom("billing_checkouts")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("paddle_env", "=", env)
        .where("transaction_id", "=", transactionId)
        .executeTakeFirst();
      return row === undefined ? undefined : toCheckout(row);
    },
  };
}
