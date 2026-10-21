// SPDX-License-Identifier: Apache-2.0

// The one writer of the instance setting `billing_settings` (ADR 0006): reading it leniently and changing it as one step. A
// change is a read-modify-write under the advisory lock of `db/billing-settings-lock.ts` in one transaction, so the rates
// (`rates-service.ts`), the adapter, the state of the Stripe account and the switch (`admin-service.ts`, #504) cannot lose each
// other's change. The change function sees the settings as they are now and returns the settings to store, or a refusal that
// writes nothing.
//
// This is not a second reader of the switch (`enabled.ts` is the one): nothing here decides on `enabled`, a caller that
// changes it states the condition itself, inside the change, where it holds the lock.
import "server-only";
import type { Kysely } from "kysely";
import { lockBillingSettings } from "../db/billing-settings-lock.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import { readBillingSettings, type BillingSettings } from "./settings.ts";

/** The error `decodeJson` throws for stored text that is no JSON (its cause is the parser's `SyntaxError`). */
function isUndecodableText(error: unknown): boolean {
  return error instanceof Error && error.cause instanceof SyntaxError;
}

export type StoredSettings = {
  settings: BillingSettings;
  /** When it was last written, or null when it never was. */
  updatedAt: string | null;
};

export async function readStoredSettings(
  db: Kysely<Database>,
): Promise<StoredSettings> {
  try {
    const stored =
      await createInstanceSettingsRepository(db).getWithMeta(
        "billing_settings",
      );
    return {
      settings: readBillingSettings(stored?.value),
      updatedAt: stored?.updatedAt ?? null,
    };
  } catch (error) {
    // Text that is no JSON at all is damaged data like any other: not set. Anything else (a lost connection, a busy
    // database) is not a statement about the settings and goes on, so a caller can retry or fail as infrastructure.
    if (!isUndecodableText(error)) throw error;
    return { settings: readBillingSettings(undefined), updatedAt: null };
  }
}

export type SettingsChange<R> =
  { write: BillingSettings; result: R } | { refuse: R };

export type BillingSettingsStore = {
  read(): Promise<StoredSettings>;
  /**
   * Runs `change` on the current settings under the lock. A `write` is stored (by `updatedBy`) and its `result` returned; a
   * `refuse` writes nothing and is returned as it is. A callback that must wait for nobody: no outbound call inside. It gets
   * the transaction as its second argument: whatever must hold together with the settings (the credentials a switch-on
   * judges, a credential that is removed) is read and written through it, in the same lock and the same transaction, and
   * is rolled back with a refusal.
   */
  change<R>(
    updatedBy: string | null,
    change: (
      current: BillingSettings,
      executor: Kysely<Database>,
    ) => Promise<SettingsChange<R>>,
  ): Promise<R>;
};

export function createBillingSettingsStore(
  db: Kysely<Database>,
): BillingSettingsStore {
  return {
    read: () => readStoredSettings(db),

    async change(updatedBy, change) {
      const run = async (trx: Kysely<Database>) => {
        await lockBillingSettings(trx);
        const { settings } = await readStoredSettings(trx);
        const outcome = await change(settings, trx);
        if ("refuse" in outcome) return outcome.refuse;
        await createInstanceSettingsRepository(trx).set(
          "billing_settings",
          outcome.write,
          updatedBy,
        );
        return outcome.result;
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },
  };
}
