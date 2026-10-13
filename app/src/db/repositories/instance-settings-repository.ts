// SPDX-License-Identifier: Apache-2.0

// Access to the instance_settings table: the settings of the whole instance, one row per setting
// with a JSON value, and who changed it last. Instance level (it belongs to no workspace). The
// setup markers live here (see src/setup/README.md); the typed service and the admin portal build
// on this table.
import "server-only";
import { lockDynamicReviewGate } from "../dynamic-review-lock.ts";
import type { Kysely } from "kysely";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
import type { StoredGithubApp } from "../../github-config/settings.ts";
import type { ImportNotice } from "../../legacy-import/notice.ts";
import type { SmtpSettings } from "../../mail/smtp-settings.ts";
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
  /**
   * The mail server (src/mail/smtp-config.ts). No row: the instance has no mail server. The password is
   * not here but in the secret store (`smtp_password`).
   */
  smtp: SmtpSettings;
  /**
   * The GitHub App (src/github-config/): app id, slug, client id and the "private app" flag. The private key,
   * the webhook secret and the client secret are in the secret store. No row: the instance has none (the
   * environment of an installation that was not imported yet is the fallback).
   */
  github_app: StoredGithubApp;
  /**
   * What the import of an existing installation could not migrate (src/legacy-import/notice.ts); shown on the
   * overview of the admin portal until the admin dismisses it. No row: nothing to tell.
   */
  import_notice: ImportNotice;
  /**
   * #195 rollout gate: whether Dynamic Review may be queued. No row (or `enabled: false`) means every
   * Dynamic project gets a run that fails visibly with `dynamic_review_disabled` instead of being
   * queued; turn it on only after every app instance runs the version that routes by `review_kind`,
   * and turn it off before rolling back to an older app (contracts/README.md).
   */
  dynamic_review: { enabled: boolean };
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
  /** Deletes the setting (it reads as never saved again); false when there was none. */
  remove(key: InstanceSettingKey): Promise<boolean>;
};

export function createInstanceSettingsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): InstanceSettingsRepository {
  async function changeGate<T>(
    key: InstanceSettingKey,
    disabling: boolean,
    change: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    if (key !== "dynamic_review") return change(db);
    const run = async (trx: Kysely<Database>) => {
      await lockDynamicReviewGate(trx, true);
      const result = await change(trx);
      if (!disabling) return result;
      const timestamp = formatTimestamp(now());
      // Fence every live Dynamic row before rollback is safe, including a holder that may release
      // or lose its lease later. Retain its token so a late completion remains fenced.
      for (const status of ["queued", "running"] as const) {
        await trx
          .updateTable("jobs")
          .set({
            status: status === "running" ? "failed" : "cancelled",
            error_code: "dynamic_review_disabled",
            lease_expires_at: null,
            finished_at: timestamp,
            updated_at: timestamp,
          })
          .where("review_kind", "=", "dynamic")
          .where("status", "=", status)
          .execute();
      }
      return result;
    };
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

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

    async remove(key) {
      return changeGate(key, true, async (executor) => {
        const result = await executor
          .deleteFrom("instance_settings")
          .where("key", "=", key)
          .executeTakeFirst();
        return Number(result.numDeletedRows) > 0;
      });
    },

    async set(key, value, updatedBy) {
      const row = {
        key,
        value: encodeJson(value),
        updated_by: updatedBy,
        updated_at: formatTimestamp(now()),
      };
      await changeGate(
        key,
        key === "dynamic_review" &&
          !(value as InstanceSettingValues["dynamic_review"]).enabled,
        async (executor) => {
          await executor
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
      );
    },
  };
}
