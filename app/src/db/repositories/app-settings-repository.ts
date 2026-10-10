// Access to the app_settings table. The only code that reads or writes it. One row per setting of the
// whole instance, the value as JSON.
import "server-only";
import type { Kysely } from "kysely";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type StoredAppSetting = {
  value: unknown;
  /** ISO 8601 text in UTC. */
  updatedAt: string;
  /** The GitHub login of the person who saved it last, or null. */
  updatedBy: string | null;
};

export type AppSettingsRepository = {
  get(key: string): Promise<StoredAppSetting | undefined>;
  /** Inserts the setting or replaces its value. */
  set(key: string, value: unknown, updatedBy: string | null): Promise<void>;
  /** Removes the setting; a setting that is not there is not an error. */
  delete(key: string): Promise<void>;
};

export function createAppSettingsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): AppSettingsRepository {
  return {
    async get(key) {
      const row = await db
        .selectFrom("app_settings")
        .selectAll()
        .where("key", "=", key)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        value: decodeJson(row.value),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    },

    async set(key, value, updatedBy) {
      const encoded = encodeJson(value);
      const updated_at = formatTimestamp(now());
      await db
        .insertInto("app_settings")
        .values({ key, value: encoded, updated_at, updated_by: updatedBy })
        .onConflict((conflict) =>
          conflict
            .column("key")
            .doUpdateSet({ value: encoded, updated_at, updated_by: updatedBy }),
        )
        .execute();
    },

    async delete(key) {
      await db.deleteFrom("app_settings").where("key", "=", key).execute();
    },
  };
}
