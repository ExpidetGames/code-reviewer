// SPDX-License-Identifier: Apache-2.0

// The rates of billing as an instance setting (ADR 0006, D2/D3, #494): the one place that writes A, B and the Diff AI
// reserve into `billing_settings`, so what is stored always passed `validateRatesPatch`, and what is read is checked
// again (`readBillingSettings`: a damaged field reads as not set). A write is a read-modify-write under an advisory
// lock, so it keeps the switch and the other fields as they are. Server-only; the admin form is #504, the claim and the
// settlement are #498.
//
// This is not a second reader of the switch (`src/billing/enabled.ts` is the one): nothing here decides on `enabled`,
// it only carries it through a write unchanged, and it reads with `getWithMeta`.
import "server-only";
import type { Kysely } from "kysely";
import { lockBillingSettings } from "../db/billing-settings-lock.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  billingRatesOf,
  validateRatesPatch,
  type BillingRateErrorCode,
  type BillingRates,
} from "./rates.ts";
import { readBillingSettings, type BillingSettings } from "./settings.ts";

export type UpdateRatesResult =
  | { ok: true; settings: BillingSettings }
  | { ok: false; code: BillingRateErrorCode; field: string };

export type BillingRatesService = {
  /** The stored settings as they read (nothing saved, or damaged: switch off, no rate). */
  settings(): Promise<BillingSettings>;
  /** The complete rates, or null while A or a B is not set (billing cannot be on then). */
  rates(): Promise<BillingRates | null>;
  /**
   * Stores the fields the change states. A refused change writes nothing. `enabled` in the change is ignored: the
   * switch is not written here.
   */
  update(change: unknown, updatedBy: string | null): Promise<UpdateRatesResult>;
};

async function readStored(db: Kysely<Database>): Promise<BillingSettings> {
  try {
    const stored =
      await createInstanceSettingsRepository(db).getWithMeta(
        "billing_settings",
      );
    return readBillingSettings(stored?.value);
  } catch {
    // Text that is no JSON at all is damaged data like any other: not set.
    return readBillingSettings(undefined);
  }
}

export function createBillingRatesService(
  db: Kysely<Database>,
): BillingRatesService {
  return {
    settings: () => readStored(db),

    async rates() {
      return billingRatesOf(await readStored(db));
    },

    async update(change, updatedBy) {
      const checked = validateRatesPatch(change);
      if (!checked.ok) return checked;
      const write = async (trx: Kysely<Database>) => {
        await lockBillingSettings(trx);
        const current = await readStored(trx);
        const next: BillingSettings = {
          ...current,
          ...checked.value,
          minuteRateMicroUsd: {
            ...current.minuteRateMicroUsd,
            ...checked.value.minuteRateMicroUsd,
          },
        };
        if (Object.keys(next.minuteRateMicroUsd ?? {}).length === 0)
          delete next.minuteRateMicroUsd;
        await createInstanceSettingsRepository(trx).set(
          "billing_settings",
          next,
          updatedBy,
        );
        return next;
      };
      const settings = db.isTransaction
        ? await write(db)
        : await db.transaction().execute(write);
      return { ok: true, settings };
    },
  };
}
