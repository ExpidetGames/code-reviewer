// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the entitlements of ONE workspace (the table `workspace_entitlements`; the factory takes the
// workspace id, see ../workspace-scope.ts): at most one row, which says what an operator allows the
// workspace. The module stores and validates; what a row means is decided only by `resolveEntitlements`
// (src/workspaces/entitlements.ts). The row of another workspace is simply not there.
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  encodeBoolean,
  encodeJson,
  formatTimestamp,
  tryDecodeJson,
} from "../codecs.ts";
import type { Database, WorkspaceEntitlementsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  INVALID_ENTITLEMENTS,
  type EntitlementsData,
  type EntitlementsEntry,
} from "../../workspaces/entitlements.ts";
import {
  EntitlementsError,
  readEntitlements,
  validateEntitlements,
} from "../../workspaces/entitlements-validation.ts";

/** Who saved a row last and when; not part of the entitlements, and not handed on by the resolver. */
type StoredMeta = {
  /** The id of the user who saved it, or null (the operator API, or a user who was deleted since). */
  updatedBy: string | null;
  /** ISO 8601 text in UTC. */
  updatedAt: string;
};

/** A stored row: readable entitlements, or `{ invalid: true }` when the row cannot be read, plus the meta. */
export type StoredEntitlements = EntitlementsEntry & StoredMeta;

export type WorkspaceEntitlementsRepository = {
  /**
   * The row of the workspace, or undefined when it has none. A row that cannot be read (limits that are
   * damaged or incomplete, a time that is none) comes back as `{ invalid: true, ... }`, never as an
   * exception and never as "no row"; `resolveEntitlements` turns it into `invalid`.
   */
  get(): Promise<StoredEntitlements | undefined>;
  /**
   * Inserts the row or replaces it, recording who and when. Refuses (with an `EntitlementsError`) what
   * `validateEntitlements` refuses, and a `periodStart` earlier than the stored one
   * (`period_start_backwards`); the same value again is accepted. Answers with the stored row.
   *
   * A `modelAccess` that is left out keeps the stored one (#428): the statement does not touch the column, so a writer
   * that does not know the field never clears what an operator granted, and two writers cannot race on it. To clear it,
   * state `{ catalogEntries: null }`. A row that is inserted by such a write starts with every released entry.
   */
  put(
    entitlements: EntitlementsData,
    updatedBy: string | null,
  ): Promise<StoredEntitlements>;
  /**
   * Deletes the row, so the instance default applies to the workspace again; false when there was none.
   * Removing ends the "period start never goes backwards" guard of this workspace: the stored start was what
   * it compared with. The operator API (#275) offers it and documents the consequence (a `put` without a start
   * begins now); the guard does not outlive the row.
   */
  remove(): Promise<boolean>;
};

/**
 * The column of the model access: NULL for "every released entry" (also what a row of before #428 has), otherwise JSON
 * text `{"catalogEntries":[...]}`. Text that is damaged reads as a value the validation refuses, so the row is
 * unreadable and grants no model.
 */
function decodeModelAccess(text: string | null): unknown {
  if (text === null) return undefined;
  const decoded = tryDecodeJson(text);
  return decoded.ok ? decoded.value : "damaged";
}

function encodeModelAccess(
  modelAccess: EntitlementsData["modelAccess"],
): string | null {
  if (modelAccess === undefined || modelAccess.catalogEntries === null)
    return null;
  return encodeJson({ catalogEntries: modelAccess.catalogEntries });
}

function toStored(row: WorkspaceEntitlementsTable): StoredEntitlements {
  const meta = { updatedBy: row.updated_by, updatedAt: row.updated_at };
  const limits = tryDecodeJson(row.limits);
  const data = readEntitlements({
    planLabel: row.plan_label,
    keyMode: row.key_mode,
    limits: limits.ok ? limits.value : undefined,
    periodStart: row.period_start,
    suspended: row.suspended === 1,
    suspensionCode: row.suspension_code,
    modelAccess: decodeModelAccess(row.model_access),
  });
  return data === undefined
    ? { ...INVALID_ENTITLEMENTS, ...meta }
    : { ...data, ...meta };
}

export function createWorkspaceEntitlementsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): WorkspaceEntitlementsRepository {
  return {
    async get() {
      const row = await db
        .selectFrom("workspace_entitlements")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

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
        model_access: encodeModelAccess(value.modelAccess),
        updated_at: formatTimestamp(moment),
        updated_by: updatedBy,
      };
      const keepModelAccess = entitlements.modelAccess === undefined;
      // One statement decides: an existing row is replaced only when the new period start is not earlier
      // than the stored one (canonical text of fixed width compares as time), so two writers cannot
      // race a start backwards. No row back means the guard refused it. `returning` answers with the row
      // this statement wrote, not with whatever another writer stored in between.
      const stored = await db
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
              ...(keepModelAccess ? {} : { model_access: row.model_access }),
              updated_at: row.updated_at,
              updated_by: row.updated_by,
            })
            .where(
              sql<boolean>`workspace_entitlements.period_start <= excluded.period_start`,
            ),
        )
        .returningAll()
        .executeTakeFirst();
      if (stored === undefined)
        throw new EntitlementsError("period_start_backwards");
      return toStored(stored);
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
