// Access to the instance_settings table: the settings of the whole instance, one row per setting
// with a JSON value, and who changed it last. Instance level (it belongs to no workspace). The
// setup markers live here (see src/setup/README.md); the typed service and the admin portal build
// on this table.
import "server-only";
import type { Kysely } from "kysely";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

/** The value of each setting, by key. A new setting adds its key and type here. */
export type InstanceSettingValues = {
  /** ISO 8601 UTC time the first-run wizard finished; null (or no row) until then. */
  setup_completed_at: string | null;
  /**
   * `none`: the import of an existing installation has not run (or was not needed). `done`: it has.
   * No row reads as `none`. Written by the import, never by the setup.
   */
  import_state: "none" | "done";
  /** `single`: one workspace for the whole instance. `multi`: users create workspaces. */
  tenancy: "single" | "multi";
  /** Who may sign up. The entries are lower case. */
  sign_up_rule:
    | { kind: "everyone" }
    | { kind: "emails"; entries: string[] }
    | { kind: "domains"; entries: string[] };
  /**
   * Which ways to sign in are switched on (src/admin/sign-in-methods.ts). No row: email with
   * password is on, and GitHub is on while it is configured.
   */
  sign_in_methods: { emailPassword: boolean; github: boolean };
  /** The most workspaces one user may own (the limits page). No row: the default (10). */
  max_workspaces_per_user: number;
};
export type InstanceSettingKey = keyof InstanceSettingValues;

/** A setting with who saved it last and when. */
export type InstanceSettingWithMeta<K extends InstanceSettingKey> = {
  value: InstanceSettingValues[K];
  /** The id of the user who saved it, or null (the system, or a user who was deleted since). */
  updatedBy: string | null;
  /** ISO 8601 text in UTC. */
  updatedAt: string;
};

export type InstanceSettingsRepository = {
  /** The value, or undefined when the setting has no row. */
  get<K extends InstanceSettingKey>(
    key: K,
  ): Promise<InstanceSettingValues[K] | undefined>;
  /** The value with who saved it last and when, or undefined when the setting has no row. */
  getWithMeta<K extends InstanceSettingKey>(
    key: K,
  ): Promise<InstanceSettingWithMeta<K> | undefined>;
  /** Inserts the setting or replaces its value, recording who and when. */
  set<K extends InstanceSettingKey>(
    key: K,
    value: InstanceSettingValues[K],
    updatedBy: string | null,
  ): Promise<void>;
};

export function createInstanceSettingsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): InstanceSettingsRepository {
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
