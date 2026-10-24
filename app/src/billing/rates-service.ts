// SPDX-License-Identifier: LicenseRef-Proprietary

// The rates of billing as an instance setting (ADR 0006, D2/D3, #494): the one place that writes A, B, the Diff AI
// reserve and the numbers next to them (the start credit, the low-balance threshold, the hourly brake; #504) into
// `billing_settings`, so what is stored always passed `validateRatesPatch`, and what is read is checked again
// (`readBillingSettings`: a damaged field reads as not set). A write is a read-modify-write under an advisory lock
// (`settings-store.ts`), so it keeps the switch, the adapter and the other fields as they are. Server-only; the admin form
// calls it (#504), the claim and the settlement are #498.
//
// This is not a second reader of the switch (`src/billing/enabled.ts` is the one): nothing here decides on `enabled`,
// it only carries it through a write unchanged, and it reads with `getWithMeta`.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import {
  billingRatesOf,
  validateRatesPatch,
  type BillingRateErrorCode,
  type BillingRates,
} from "./rates.ts";
import type { BillingSettings } from "./settings.ts";
import { createBillingSettingsStore } from "./settings-store.ts";

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

export function createBillingRatesService(
  db: Kysely<Database>,
): BillingRatesService {
  const store = createBillingSettingsStore(db);
  return {
    settings: async () => (await store.read()).settings,

    async rates() {
      return billingRatesOf((await store.read()).settings);
    },

    async update(change, updatedBy) {
      const checked = validateRatesPatch(change);
      if (!checked.ok) return checked;
      return store.change<UpdateRatesResult>(updatedBy, async (current) => {
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
        return Promise.resolve({
          write: next,
          result: { ok: true, settings: next },
        });
      });
    },
  };
}
