// SPDX-License-Identifier: Apache-2.0

// The Paddle customer of ONE workspace (`billing_customers`; the factory takes the workspace id, see ../workspace-scope.ts; #441,
// ADR 0005, 2.12). The app creates no Paddle customer: the id is adopted from the first `subscription.created` and used by later
// checkouts and the portal. One row per workspace and environment; a newer adoption replaces the id (the person who pays may
// change between two subscriptions). An id only: no name, email or address is stored.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import type { PaddleEnv } from "./billing-plan-prices-repository.ts";

export type BillingCustomersRepository = {
  /** Stores the customer id for the environment, or replaces the one stored. */
  adopt(env: PaddleEnv, paddleCustomerId: string): Promise<void>;
  get(env: PaddleEnv): Promise<string | undefined>;
};

export function createBillingCustomersRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): BillingCustomersRepository {
  return {
    async adopt(env, paddleCustomerId) {
      const at = formatTimestamp(now());
      await db
        .insertInto("billing_customers")
        .values({
          workspace_id: workspaceId,
          paddle_env: env,
          paddle_customer_id: paddleCustomerId,
          created_at: at,
          updated_at: at,
        })
        .onConflict((conflict) =>
          conflict.columns(["workspace_id", "paddle_env"]).doUpdateSet({
            paddle_customer_id: paddleCustomerId,
            updated_at: at,
          }),
        )
        .execute();
    },

    async get(env) {
      const row = await db
        .selectFrom("billing_customers")
        .select("paddle_customer_id")
        .where("workspace_id", "=", workspaceId)
        .where("paddle_env", "=", env)
        .executeTakeFirst();
      return row?.paddle_customer_id;
    },
  };
}
