// SPDX-License-Identifier: Apache-2.0

// Access to the entitlements of ONE workspace (the table `workspace_entitlements`; the factory takes the
// workspace id, see ../workspace-scope.ts): at most one row, which says what an operator allows the
// workspace. The module stores and validates; what a row means is decided only by `resolveEntitlements`
// (src/workspaces/entitlements.ts). The row of another workspace is simply not there.
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  decodeBoolean,
  decodeJson,
  encodeBoolean,
  encodeJson,
  formatTimestamp,
} from "../codecs.ts";
import type { Database, WorkspaceEntitlementsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import type {
  EntitlementLimits,
  EntitlementsData,
  KeyMode,
} from "../../workspaces/entitlements.ts";
import {
  EntitlementsError,
  validateEntitlements,
} from "../../workspaces/entitlements-validation.ts";

/** A stored row: the entitlements with who saved them last and when. */
export type StoredEntitlements = EntitlementsData & {
  /** The id of the user who saved it, or null (the operator API, or a user who was deleted since). */
  updatedBy: string | null;
  /** ISO 8601 text in UTC. */
  updatedAt: string;
};

export type WorkspaceEntitlementsRepository = {
  /** The row of the workspace, or undefined when it has none. */
  get(): Promise<StoredEntitlements | undefined>;
  /**
   * Inserts the row or replaces it, recording who and when. Refuses (with an `EntitlementsError`) what
   * `validateEntitlements` refuses, and a `periodStart` earlier than the stored one
   * (`period_start_backwards`); the same value again is accepted. Answers with the stored row.
   */
  put(
    entitlements: EntitlementsData,
    updatedBy: string | null,
  ): Promise<StoredEntitlements>;
  /** Deletes the row, so the instance default (or unlimited) applies again; false when there was none. */
  remove(): Promise<boolean>;
};

function toStored(row: WorkspaceEntitlementsTable): StoredEntitlements {
  return {
    planLabel: row.plan_label,
    keyMode: row.key_mode as KeyMode,
    limits: decodeJson<EntitlementLimits>(row.limits),
    periodStart: row.period_start,
    suspended: decodeBoolean(row.suspended),
    suspensionCode: row.suspension_code,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export function createWorkspaceEntitlementsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): WorkspaceEntitlementsRepository {
  async function get(): Promise<StoredEntitlements | undefined> {
    const row = await db
      .selectFrom("workspace_entitlements")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row === undefined ? undefined : toStored(row);
  }

  return {
    get,

    async put(entitlements, updatedBy) {
      const moment = now();
      const checked = validateEntitlements(entitlements, moment);
      if (!checked.ok) throw new EntitlementsError(checked.code, checked.field);
      const value = checked.value;
      const row: WorkspaceEntitlementsTable = {
        workspace_id: workspaceId,
        plan_label: value.planLabel,
        key_mode: value.keyMode,
        limits: encodeJson(value.limits),
        period_start: value.periodStart,
        suspended: encodeBoolean(value.suspended),
        suspension_code: value.suspensionCode,
        updated_at: formatTimestamp(moment),
        updated_by: updatedBy,
      };
      // One statement decides: an existing row is replaced only when the new period start is not earlier
      // than the stored one (canonical text of fixed width compares as time), so two writers cannot
      // race a start backwards. No row written means the guard refused it.
      const result = await db
        .insertInto("workspace_entitlements")
        .values(row)
        .onConflict((conflict) =>
          conflict
            .column("workspace_id")
            .doUpdateSet({
              plan_label: row.plan_label,
              key_mode: row.key_mode,
              limits: row.limits,
              period_start: row.period_start,
              suspended: row.suspended,
              suspension_code: row.suspension_code,
              updated_at: row.updated_at,
              updated_by: row.updated_by,
            })
            .where(
              sql<boolean>`workspace_entitlements.period_start <= excluded.period_start`,
            ),
        )
        .executeTakeFirst();
      if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0)
        throw new EntitlementsError("period_start_backwards");
      const stored = await get();
      if (stored === undefined)
        throw new Error("The entitlements row is gone right after its write.");
      return stored;
    },

    async remove() {
      const result = await db
        .deleteFrom("workspace_entitlements")
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
