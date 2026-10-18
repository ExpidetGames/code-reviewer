// SPDX-License-Identifier: Apache-2.0

// Finds the workspace a Paddle event belongs to (#441, ADR 0005, 2.12). A webhook arrives with Paddle's ids and without a
// workspace, so the scoped repositories cannot be made yet. This module only reads, never lists, and every answer is the id of
// one workspace for one Paddle id the app itself wrote down: a checkout row of ours (by the transaction the server created) or
// a subscription row of ours. Everything that follows goes through the repositories created for that workspace.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";
import type { PaddleEnv } from "./billing-plan-prices-repository.ts";

export type BillingDirectoryRepository = {
  workspaceOfCheckout(
    env: PaddleEnv,
    transactionId: string,
  ): Promise<string | undefined>;
  workspaceOfSubscription(
    env: PaddleEnv,
    paddleSubscriptionId: string,
  ): Promise<string | undefined>;
};

export function createBillingDirectoryRepository(
  db: Kysely<Database>,
): BillingDirectoryRepository {
  return {
    async workspaceOfCheckout(env, transactionId) {
      const row = await db
        .selectFrom("billing_checkouts")
        .select("workspace_id")
        .where("paddle_env", "=", env)
        .where("transaction_id", "=", transactionId)
        .executeTakeFirst();
      return row?.workspace_id;
    },

    async workspaceOfSubscription(env, paddleSubscriptionId) {
      const row = await db
        .selectFrom("billing_subscriptions")
        .select("workspace_id")
        .where("paddle_env", "=", env)
        .where("paddle_subscription_id", "=", paddleSubscriptionId)
        .executeTakeFirst();
      return row?.workspace_id;
    },
  };
}
