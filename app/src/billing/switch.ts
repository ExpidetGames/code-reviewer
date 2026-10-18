// SPDX-License-Identifier: Apache-2.0

// Whether the billing switch is on, and nothing else (#438). `isBillingOn` (enabled.ts) also checks that the Paddle secrets
// can be read, which needs the secret store; the operator API has no way to the secret store (whoever holds its token must
// not hold the keys, src/operator-api/no-operator-keys.test.ts), and it only has to know whether billing owns the default
// entitlements: it does as long as the switch is on. Reads one instance setting.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import { readBillingSettings } from "./settings.ts";

export async function isBillingSwitchedOn(
  db: Kysely<Database>,
): Promise<boolean> {
  const stored =
    await createInstanceSettingsRepository(db).get("billing_settings");
  return stored !== undefined && readBillingSettings(stored).enabled;
}
