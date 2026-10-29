// SPDX-License-Identifier: LicenseRef-Proprietary

// The generic key/value store behind the instance_settings table (#715, cut 2): one row per setting with a JSON
// value, and who changed it last. It knows no setting. The value type of each key is a type parameter, so a
// domain (billing, mail, ...) states the keys it owns and reads and writes them through the store without
// importing the repository of the whole instance, which in turn imports every domain's value type
// (`instance-settings-repository.ts`: the typed map of all keys and the settings with their own rules).
import "server-only";
import type { Kysely } from "kysely";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

/** A setting with who saved it last and when. */
export type StoredSetting<Value> = {
  value: Value;
  /** The id of the user who saved it, or null (the system, or a user who was deleted since). */
  updatedBy: string | null;
  /** ISO 8601 text in UTC. */
  updatedAt: string;
};

/** The settings of one domain: the value of each key it owns, by key. */
export type SettingValues = Record<string, unknown>;

export type InstanceSettingsStore<Values extends SettingValues> = {
  /** The value, or undefined when the setting has no row. */
  get<K extends keyof Values & string>(key: K): Promise<Values[K] | undefined>;
  /** The value with who saved it last and when, or undefined when the setting has no row. */
  getWithMeta<K extends keyof Values & string>(
    key: K,
  ): Promise<StoredSetting<Values[K]> | undefined>;
  /** Inserts the setting or replaces its value, recording who and when. */
  set<K extends keyof Values & string>(
    key: K,
    value: Values[K],
    updatedBy: string | null,
  ): Promise<void>;
  /**
   * Takes the setting as a lease: inserts it, or replaces it when its last write is older than `staleBefore`
   * (ISO 8601 text). False when somebody else holds it. Release it with `release`.
   */
  claim<K extends keyof Values & string>(
    key: K,
    value: Values[K],
    updatedBy: string | null,
    staleBefore: string,
  ): Promise<boolean>;
  /**
   * Releases a lease taken with `claim`, only while it still holds `value`, the one this holder claimed with. A holder
   * whose lease ran out and was taken over leaves the new holder's lease alone. False when it is not (or no longer) held.
   */
  release<K extends keyof Values & string>(
    key: K,
    value: Values[K],
  ): Promise<boolean>;
  /** Deletes the setting (it reads as never saved again); false when there was none. */
  remove(key: keyof Values & string): Promise<boolean>;
};

export function createInstanceSettingsStore<Values extends SettingValues>(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): InstanceSettingsStore<Values> {
  return {
    async get(key) {
      const row = await db
        .selectFrom("instance_settings")
        .select("value")
        .where("key", "=", key)
        .executeTakeFirst();
      return row === undefined ? undefined : decodeJson(row.value);
    },

    async getWithMeta(key) {
      const row = await db
        .selectFrom("instance_settings")
        .select(["value", "updated_by", "updated_at"])
        .where("key", "=", key)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            value: decodeJson(row.value),
            updatedBy: row.updated_by,
            updatedAt: row.updated_at,
          };
    },

    async claim(key, value, updatedBy, staleBefore) {
      const row = {
        key,
        value: encodeJson(value),
        updated_by: updatedBy,
        updated_at: formatTimestamp(now()),
      };
      const claimed = await db
        .insertInto("instance_settings")
        .values(row)
        .onConflict((conflict) =>
          conflict
            .column("key")
            .doUpdateSet({
              value: row.value,
              updated_by: row.updated_by,
              updated_at: row.updated_at,
            })
            .where("instance_settings.updated_at", "<", staleBefore),
        )
        .executeTakeFirst();
      return Number(claimed.numInsertedOrUpdatedRows ?? 0) > 0;
    },

    async release(key, value) {
      const result = await db
        .deleteFrom("instance_settings")
        .where("key", "=", key)
        .where("value", "=", encodeJson(value))
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async remove(key) {
      const result = await db
        .deleteFrom("instance_settings")
        .where("key", "=", key)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async set(key, value, updatedBy) {
      const row = {
        key,
        value: encodeJson(value),
        updated_by: updatedBy,
        updated_at: formatTimestamp(now()),
      };
      await db
        .insertInto("instance_settings")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("key").doUpdateSet({
            value: row.value,
            updated_by: row.updated_by,
            updated_at: row.updated_at,
          }),
        )
        .execute();
    },
  };
}
