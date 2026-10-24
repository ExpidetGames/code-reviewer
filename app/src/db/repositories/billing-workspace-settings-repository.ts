// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings ONE workspace makes for its own billing (table `billing_workspace_settings`; the factory takes the workspace id,
// see ../workspace-scope.ts; ADR 0006, 2.9; #499; src/billing/README.md): today the optional monthly total limit in
// micro-USD, or none. A workspace without a row has no limit. The repository knows no role: who may change it is the service's
// rule (`src/billing/monthly-limit-service.ts`). The limit is a `bigint` on Postgres, which reads it back as text, so it is
// converted (`Number`, exact up to 2^53 micro-USD).
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { BillingWorkspaceSettingsTable, Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type WorkspaceBillingSettings = {
  /** Micro-USD, or null for no limit. */
  monthlyLimitMicroUsd: number | null;
  /** The user who last changed it; null once that user is gone, or for a change nobody made. */
  updatedBy: string | null;
  updatedAt: string;
};

function toSettings(
  row: Selectable<BillingWorkspaceSettingsTable>,
): WorkspaceBillingSettings {
  return {
    monthlyLimitMicroUsd:
      row.monthly_limit_micro_usd === null
        ? null
        : Number(row.monthly_limit_micro_usd),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export type BillingWorkspaceSettingsRepository = {
  get(): Promise<WorkspaceBillingSettings | undefined>;
  /** The monthly total limit in micro-USD, or null when none is set (also when the workspace has no row). */
  monthlyLimitMicroUsd(): Promise<number | null>;
  /**
   * Sets the limit (a positive whole number of micro-USD) or clears it with null, and records who did and when. Throws a
   * `TypeError` for any other number, before anything is written.
   */
  setMonthlyLimit(
    limitMicroUsd: number | null,
    userId: string | null,
  ): Promise<WorkspaceBillingSettings>;
};

export function createBillingWorkspaceSettingsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): BillingWorkspaceSettingsRepository {
  async function find() {
    const row = await db
      .selectFrom("billing_workspace_settings")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row === undefined ? undefined : toSettings(row);
  }

  return {
    get: find,

    async monthlyLimitMicroUsd() {
      return (await find())?.monthlyLimitMicroUsd ?? null;
    },

    async setMonthlyLimit(limitMicroUsd, userId) {
      if (
        limitMicroUsd !== null &&
        !(Number.isSafeInteger(limitMicroUsd) && limitMicroUsd > 0)
      )
        throw new TypeError("a monthly limit is a positive whole number");
      const change = {
        monthly_limit_micro_usd: limitMicroUsd,
        updated_by: userId,
        updated_at: formatTimestamp(now()),
      };
      const row = await db
        .insertInto("billing_workspace_settings")
        .values({ workspace_id: workspaceId, ...change })
        .onConflict((conflict) =>
          conflict.column("workspace_id").doUpdateSet(change),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSettings(row);
    },
  };
}
