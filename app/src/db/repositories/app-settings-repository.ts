// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the app_settings table of ONE workspace (the factory takes the workspace id; see
// ../workspace-scope.ts). The only code that reads or writes it. One row per setting of a workspace,
// the value as JSON.
import "server-only";
import type { Kysely } from "kysely";
import { encodeJson, formatTimestamp, tryDecodeJson } from "../codecs.ts";
import { lockDynamicReviewGate } from "../dynamic-review-lock.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type StoredAppSetting = {
  /** The stored value; `undefined` when the stored text is not valid JSON (a warning is logged). */
  value: unknown;
  /** ISO 8601 text in UTC. */
  updatedAt: string;
  /** The GitHub login of the person who saved it last, or null. */
  updatedBy: string | null;
};

export type AppSettingsRepository = {
  get(key: string): Promise<StoredAppSetting | undefined>;
  /**
   * Inserts the setting or replaces its value. `afterWrite` runs in the same transaction, so what it does commits or rolls back
   * with the write (#676).
   */
  set(
    key: string,
    value: unknown,
    updatedBy: string | null,
    afterWrite?: (executor: Kysely<Database>) => Promise<void>,
  ): Promise<void>;
  /**
   * Replaces the value only while the setting is as the caller last read it: `expectedUpdatedAt` is the `updatedAt` it read,
   * or null when it read no row (#676). Answers false, and writes nothing, when somebody saved meanwhile. `afterWrite` runs in
   * the same transaction, so what it does commits or rolls back with the write.
   */
  setIfUnchanged(
    key: string,
    value: unknown,
    updatedBy: string | null,
    expectedUpdatedAt: string | null,
    afterWrite?: (executor: Kysely<Database>) => Promise<void>,
  ): Promise<boolean>;
  /** Removes the setting; a setting that is not there is not an error. */
  delete(key: string): Promise<void>;
};

export function createAppSettingsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  warn: (message: string) => void = console.warn,
): AppSettingsRepository {
  return {
    async get(key) {
      const row = await db
        .selectFrom("app_settings")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("key", "=", key)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      // Damaged text must not take every reader down: the caller falls back to its default. The
      // warning names the setting, never the text.
      const decoded = tryDecodeJson(row.value);
      if (!decoded.ok)
        warn(
          `[db] APP_SETTING_UNREADABLE: the stored value of the setting "${row.key}" is not valid JSON and is ignored.`,
        );
      return {
        value: decoded.ok ? decoded.value : undefined,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    },

    async set(key, value, updatedBy, afterWrite) {
      const encoded = encodeJson(value);
      const updated_at = formatTimestamp(now());
      const run = async (executor: Kysely<Database>) => {
        if (afterWrite !== undefined)
          await lockDynamicReviewGate(executor, false);
        await executor
          .insertInto("app_settings")
          .values({
            workspace_id: workspaceId,
            key,
            value: encoded,
            updated_at,
            updated_by: updatedBy,
          })
          .onConflict((conflict) =>
            conflict.columns(["workspace_id", "key"]).doUpdateSet({
              value: encoded,
              updated_at,
              updated_by: updatedBy,
            }),
          )
          .execute();
        if (afterWrite !== undefined) await afterWrite(executor);
      };
      if (afterWrite === undefined || db.isTransaction) return run(db);
      return db.transaction().execute(run);
    },

    async setIfUnchanged(key, value, updatedBy, expectedUpdatedAt, afterWrite) {
      const encoded = encodeJson(value);
      const updated_at = formatTimestamp(now());
      const run = async (executor: Kysely<Database>): Promise<boolean> => {
        // The same order of locks as every write that cancels jobs: the Dynamic gate first.
        await lockDynamicReviewGate(executor, false);
        // One conditional statement decides, so two saves of the same read cannot both win on either engine.
        if (expectedUpdatedAt === null) {
          const inserted = await executor
            .insertInto("app_settings")
            .values({
              workspace_id: workspaceId,
              key,
              value: encoded,
              updated_at,
              updated_by: updatedBy,
            })
            .onConflict((conflict) => conflict.doNothing())
            .executeTakeFirst();
          if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0)
            return false;
        } else {
          const updated = await executor
            .updateTable("app_settings")
            .set({ value: encoded, updated_at, updated_by: updatedBy })
            .where("workspace_id", "=", workspaceId)
            .where("key", "=", key)
            .where("updated_at", "=", expectedUpdatedAt)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) === 0) return false;
        }
        if (afterWrite !== undefined) await afterWrite(executor);
        return true;
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },

    async delete(key) {
      await db
        .deleteFrom("app_settings")
        .where("workspace_id", "=", workspaceId)
        .where("key", "=", key)
        .execute();
    },
  };
}
