// SPDX-License-Identifier: Apache-2.0

// The billing switch written straight into a test database, for tests of code that runs only while billing is on. Billing is
// on only when the adapter is ready (#504), so the switch is written with made-up rates of the manual adapter, which is ready
// with nothing but the rates. No rate of an operator is in the repository.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";

export async function setBillingSwitch(
  db: Kysely<Database>,
  enabled: boolean,
): Promise<void> {
  await createInstanceSettingsRepository(db).set(
    "billing_settings",
    enabled
      ? {
          enabled,
          factorA: 50_000,
          minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
          diffAiReserveMicroUsd: 150_000,
        }
      : { enabled },
    null,
  );
}
