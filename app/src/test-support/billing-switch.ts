// SPDX-License-Identifier: Apache-2.0

// The billing switch written straight into a test database, for tests of code that runs only while billing is on. Switching
// it on also sets made-up rates, because the claim refuses a job while billing is on and a rate is missing (#498); none of
// these numbers is a real one.
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type { StoredBillingRates } from "../billing/rates.ts";

/** Made-up rates: A = 5.0, B(Diff) = 13,000 and B(Dynamic) = 16,000 micro-USD a minute, a Diff AI reserve of 150,000. */
export const TEST_BILLING_RATES = {
  factorA: 50_000,
  minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
  diffAiReserveMicroUsd: 150_000,
} as const satisfies StoredBillingRates;

export async function setBillingSwitch(
  db: Kysely<Database>,
  enabled: boolean,
  rates: StoredBillingRates | null = enabled ? TEST_BILLING_RATES : null,
): Promise<void> {
  await createInstanceSettingsRepository(db).set(
    "billing_settings",
    { enabled, ...(rates ?? {}) },
    null,
  );
}

let fundings = 0;

/** Credits a workspace with a top-up of `microUsd`, so its claims can hold money. */
export async function fundWorkspace(
  db: Kysely<Database>,
  workspaceId: string,
  microUsd: number,
  now?: () => Date,
): Promise<void> {
  fundings += 1;
  const reference = `test-funding-${String(fundings)}-${crypto.randomUUID()}`;
  await createBillingJournalRepository(db, workspaceId, now).append({
    type: "top_up",
    amountMicroUsd: microUsd,
    provider: "manual",
    providerRef: reference,
    refKey: reference,
  });
}
