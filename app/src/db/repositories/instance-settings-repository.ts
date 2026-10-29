// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the instance_settings table: the settings of the whole instance, one row per setting
// with a JSON value, and who changed it last. Instance level (it belongs to no workspace). The
// setup markers live here (see src/setup/README.md); the typed service and the admin portal build
// on this table. This is the typed map of every setting of the instance and the two settings with rules
// of their own (the default entitlements, the Dynamic Review gate); the plain reads and writes are the
// generic store (`instance-settings-store.ts`), which a domain uses for the keys it owns, so that
// the domain does not import this file and, through it, the value types of all the other domains (#715).
import "server-only";
import {
  lockDynamicReviewGate,
  lockJobRowsInOrder,
} from "../dynamic-review-lock.ts";
import type { Kysely } from "kysely";
import { encodeJson, formatTimestamp, tryDecodeJson } from "../codecs.ts";
import { lockDefaultEntitlements } from "../entitlements-lock.ts";
import {
  INVALID_ENTITLEMENTS,
  type EntitlementsData,
  type EntitlementsEntry,
  type ModelAccess,
} from "../../workspaces/entitlements.ts";
import {
  EntitlementsError,
  checkPeriodStartNotBackwards,
  readEntitlements,
  validateEntitlements,
} from "../../workspaces/entitlements-validation.ts";
import type { DispatcherSightings } from "../../billing/dispatcher-features.ts";
import type { StoredJournalCheck } from "../../billing/journal-check.ts";
import type { BillingSettings } from "../../billing/settings.ts";
import type { StoredGithubApp } from "../../github-config/settings.ts";
import type { CatalogDefaults } from "../../model-catalog/entries.ts";
import type { SmtpSettings } from "../../mail/smtp-settings.ts";
import type { Database } from "../schema.ts";
import type { SignUpRule, Tenancy } from "./instance-setting-types.ts";
import {
  createInstanceSettingsStore,
  type StoredSetting,
} from "./instance-settings-store.ts";
import { closeRecordsOfEndedJobs } from "./usage-records-sweep.ts";

/** The value of each setting, by key. A new setting adds its key and type here. */
export type InstanceSettingValues = {
  /** ISO 8601 UTC time the first-run wizard finished; null (or no row) until then. */
  setup_completed_at: string | null;
  /** `single`: one workspace for the whole instance. `multi`: users create workspaces. */
  tenancy: Tenancy;
  /** Who may sign up. The entries are lower case. */
  sign_up_rule: SignUpRule;
  /**
   * Which ways to sign in are switched on (src/admin/sign-in-methods.ts). No row: email with
   * password is on, and GitHub is on while it is configured.
   */
  sign_in_methods: { emailPassword: boolean; github: boolean };
  /** The most workspaces one user may own (the limits page). No row: the default (10). */
  max_workspaces_per_user: number;
  /**
   * #553: the most tokens (prompt, cache and completion in all) a Dynamic run on the workspace's own key may use when its
   * price is not known (src/native-cost/token-cap.ts). No row: the default (4,000,000). The admin sets it within bounds;
   * a stored value outside them reads as the default.
   */
  own_key_max_total_tokens: number;
  /**
   * #689: the most one review may cost, in whole US cents, for both review kinds (src/review-settings/operator-cost-limit.ts). No
   * row: the default (1.00 USD). The admin sets it within bounds; a stored value outside them reads as the default. A
   * customer's own cost limit can only be lower, and the limit of a job is the smaller of the two.
   */
  review_max_cost_cents: number;
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
   * #195 rollout gate: whether Dynamic Review may be queued. No row (or `enabled: false`) means every
   * Dynamic project gets a run that fails visibly with `dynamic_review_disabled` instead of being
   * queued; turn it on only after every app instance runs the version that routes by `review_kind`,
   * and turn it off before rolling back to an older app (contracts/README.md).
   */
  dynamic_review: { enabled: boolean };
  /**
   * #271: the entitlements of every workspace that has no row of its own (the fields of a workspace row). No
   * row: such a workspace is unlimited (own key, no limits, not suspended), as before. `set` refuses what
   * `validateEntitlements` refuses and a `periodStart` earlier than the stored one.
   */
  default_entitlements: EntitlementsData;
  /**
   * #284: the operator-configured page an Owner or Admin is handed over to ("Manage plan"; src/plan-handoff/): an
   * absolute `https:` address, checked by `checkPlanManagementUrl` when it is saved and again when it is read. No row:
   * there is no such page, no button and no route, and no refusal notice links to the plan page.
   */
  plan_management_url: string;
  /**
   * #425: the instance default entry of the model catalog per kind of review (src/model-catalog/): `{ diff, dynamic }`,
   * each the id of a released entry that serves the kind, or null. Written by the catalog service only, which reads it
   * again against the entries (a default that is no longer fit reads as none). No row: no default.
   */
  catalog_defaults: CatalogDefaults;
  /**
   * The billing module's settings (src/billing/, ADR 0006): the `enabled` switch and the rates (A, B per kind, the Diff AI
   * reserve; written by `rates-service.ts` only). A value of an older shape reads with the fields it no longer has ignored,
   * and a damaged rate reads as not set (`readBillingSettings`). No row: billing was never configured, which is off
   * and inert (`isBillingOn`).
   */
  billing_settings: BillingSettings;
  /**
   * #498: when the app last saw a Dispatcher that reports its VMs (`vm_lifecycle`) and one that does not, so billing is not
   * switched on over the second (src/billing/dispatcher-features.ts). Written by `noteDispatcherClaim` only; a value that is not the
   * shape reads as no sighting. No row: no Dispatcher has claimed.
   */
  dispatcher_sightings: DispatcherSightings;
  /**
   * #626: the state of the scheduled check of the journal (src/billing/journal-check.ts): the result of the last pass and the
   * progress of the one under way. Written by the check only; a value that is not the shape reads as no check made. No row: none.
   */
  billing_journal_check: StoredJournalCheck;
  /**
   * #504: the lease that serializes the creation of the Stripe webhook endpoint (src/billing/): one admin action at a time
   * makes one. Taken with `claim`, released with `release`; a lease that ran out is taken over.
   */
  billing_destination_lock: { startedAt: string };
};
export type InstanceSettingKey = keyof InstanceSettingValues;
/** The settings that are leases (`claim`, `release`), not values an admin sets. */
export type LeaseSettingKey = "billing_destination_lock";
/**
 * The keys `get` and `getWithMeta` read as stored. The default entitlements are not among them: their stored
 * JSON is not trusted and is read through `getDefaultEntitlements`, which checks it.
 */
export type ReadableSettingKey = Exclude<
  InstanceSettingKey,
  "default_entitlements"
>;

/** A setting with who saved it last and when. */
export type InstanceSettingWithMeta<K extends ReadableSettingKey> =
  StoredSetting<InstanceSettingValues[K]>;

export type InstanceSettingsRepository = {
  /** The value, or undefined when the setting has no row. */
  get<K extends ReadableSettingKey>(
    key: K,
  ): Promise<InstanceSettingValues[K] | undefined>;
  /** The value with who saved it last and when, or undefined when the setting has no row. */
  getWithMeta<K extends ReadableSettingKey>(
    key: K,
  ): Promise<InstanceSettingWithMeta<K> | undefined>;
  /**
   * The default entitlements, or undefined when none were set. Damaged JSON or data that fails the same
   * validation as a write comes back as `{ invalid: true }`, never as an exception and never as undefined;
   * `resolveEntitlements` turns it into `invalid` for every workspace without a row of its own.
   */
  getDefaultEntitlements(): Promise<EntitlementsEntry | undefined>;
  /** Inserts the setting or replaces its value, recording who and when. */
  set<K extends InstanceSettingKey>(
    key: K,
    value: InstanceSettingValues[K],
    updatedBy: string | null,
  ): Promise<void>;
  /**
   * Takes the setting as a lease: inserts it, or replaces it when its last write is older than `staleBefore`
   * (ISO 8601 text). False when somebody else holds it. Release it with `release`.
   */
  claim<K extends LeaseSettingKey>(
    key: K,
    value: InstanceSettingValues[K],
    updatedBy: string | null,
    staleBefore: string,
  ): Promise<boolean>;
  /**
   * Releases a lease taken with `claim`, only while it still holds `value`, the one this holder claimed with. A holder
   * whose lease ran out and was taken over leaves the new holder's lease alone. False when it is not (or no longer) held.
   */
  release<K extends LeaseSettingKey>(
    key: K,
    value: InstanceSettingValues[K],
  ): Promise<boolean>;
  /** Deletes the setting (it reads as never saved again); false when there was none. */
  remove(key: InstanceSettingKey): Promise<boolean>;
};

export function createInstanceSettingsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): InstanceSettingsRepository {
  const store = createInstanceSettingsStore<InstanceSettingValues>(db, now);

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
      // Running jobs retain their lease and PR slot until completion or a lost attempt. Only
      // waiting work is cancelled here; loseAttempt reads the gate under the same lock discipline.
      await lockJobRowsInOrder(
        trx,
        trx
          .selectFrom("jobs")
          .select("id")
          .where("review_kind", "=", "dynamic")
          .where("status", "=", "queued"),
      );
      await trx
        .updateTable("jobs")
        .set({
          status: "cancelled",
          error_code: "dynamic_review_disabled",
          finished_at: timestamp,
          updated_at: timestamp,
        })
        .where("review_kind", "=", "dynamic")
        .where("status", "=", "queued")
        .execute();
      // A job that waited again after a lost lease keeps a reserved usage record; it no longer counts.
      await closeRecordsOfEndedJobs(trx, timestamp);
      return result;
    };
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  function readStoredDefault(text: string): {
    entry: EntitlementsEntry;
    readable: boolean;
    periodStart: string | undefined;
    modelAccess: ModelAccess | undefined;
  } {
    const decoded = tryDecodeJson(text);
    const data = decoded.ok ? readEntitlements(decoded.value) : undefined;
    return data === undefined
      ? {
          entry: INVALID_ENTITLEMENTS,
          readable: false,
          periodStart: undefined,
          modelAccess: undefined,
        }
      : {
          entry: data,
          readable: true,
          periodStart: data.periodStart,
          modelAccess: data.modelAccess,
        };
  }

  /**
   * The default entitlements are validated like a workspace row, and the period start is checked against the
   * stored one under a lock (an advisory transaction lock: the value is JSON and there may be no row to
   * lock).
   */
  async function setDefaultEntitlements(
    value: EntitlementsData,
    updatedBy: string | null,
  ): Promise<void> {
    const moment = now();
    const checked = validateEntitlements(value, moment);
    if (!checked.ok) throw new EntitlementsError(checked.code, checked.field);
    const key = "default_entitlements";
    const write = async (trx: Kysely<Database>) => {
      await lockDefaultEntitlements(trx);
      const stored = await trx
        .selectFrom("instance_settings")
        .select("value")
        .where("key", "=", key)
        .executeTakeFirst();
      // An unreadable stored default has no period start to protect; a valid write that states `modelAccess` repairs it.
      const storedDefault =
        stored === undefined ? undefined : readStoredDefault(stored.value);
      const refused = checkPeriodStartNotBackwards(
        checked.value.periodStart,
        storedDefault?.periodStart,
      );
      if (refused !== undefined) throw new EntitlementsError(refused);
      // #428: a model access that the write leaves out keeps the stored one (the lock above makes it atomic). When the
      // stored default is unreadable there is nothing to keep, and "every released entry" is not a safe guess for data
      // that may have been restrictive: the write is refused, as a workspace row stays unreadable under such a write,
      // and only a write that states `modelAccess` repairs the default.
      if (
        value.modelAccess === undefined &&
        storedDefault !== undefined &&
        !storedDefault.readable
      )
        throw new EntitlementsError("catalog_entry_invalid", "modelAccess");
      const modelAccess =
        value.modelAccess === undefined
          ? (storedDefault?.modelAccess ?? checked.value.modelAccess)
          : checked.value.modelAccess;
      const row = {
        key,
        value: encodeJson({ ...checked.value, modelAccess }),
        updated_by: updatedBy,
        updated_at: formatTimestamp(moment),
      };
      await trx
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
    };
    return db.isTransaction ? write(db) : db.transaction().execute(write);
  }

  return {
    async getDefaultEntitlements() {
      const row = await db
        .selectFrom("instance_settings")
        .select("value")
        .where("key", "=", "default_entitlements")
        .executeTakeFirst();
      return row === undefined ? undefined : readStoredDefault(row.value).entry;
    },

    async get(key) {
      return store.get(key);
    },

    async getWithMeta(key) {
      return store.getWithMeta(key);
    },

    async claim(key, value, updatedBy, staleBefore) {
      return store.claim(key, value, updatedBy, staleBefore);
    },

    async release(key, value) {
      return store.release(key, value);
    },

    async remove(key) {
      return changeGate(key, true, (executor) =>
        createInstanceSettingsStore<InstanceSettingValues>(
          executor,
          now,
        ).remove(key),
      );
    },

    async set(key, value, updatedBy) {
      if (key === "default_entitlements")
        return setDefaultEntitlements(
          value as InstanceSettingValues["default_entitlements"],
          updatedBy,
        );
      await changeGate(
        key,
        key === "dynamic_review" &&
          !(value as InstanceSettingValues["dynamic_review"]).enabled,
        (executor) =>
          createInstanceSettingsStore<InstanceSettingValues>(executor, now).set(
            key,
            value,
            updatedBy,
          ),
      );
    },
  };
}
