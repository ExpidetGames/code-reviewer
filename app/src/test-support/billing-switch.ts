// SPDX-License-Identifier: Apache-2.0

// The billing switch written straight into a test database, for tests of code that runs only while billing is on.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";

export async function setBillingSwitch(
  db: Kysely<Database>,
  enabled: boolean,
): Promise<void> {
  await createInstanceSettingsRepository(db).set(
    "billing_settings",
    { enabled },
    null,
  );
}
