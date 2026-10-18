// SPDX-License-Identifier: Apache-2.0

// The billing switch written straight into a test database (#438), for tests of code that runs only while billing is on:
// the writer of the default entitlements that billing owns checks the switch in its own transaction and writes nothing
// while it is off. The settings are the made-up ones of the other billing tests; the secrets are not needed to read the
// switch.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";

export const TEST_BILLING_SETTINGS = {
  environment: "sandbox",
  clientToken: "test_0123456789abcdef0123456789a",
  graceDays: 7,
} as const;

export async function setBillingSwitch(
  db: Kysely<Database>,
  enabled: boolean,
): Promise<void> {
  await createInstanceSettingsRepository(db).set(
    "billing_settings",
    { ...TEST_BILLING_SETTINGS, enabled },
    null,
  );
}
