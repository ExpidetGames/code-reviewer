// SPDX-License-Identifier: Apache-2.0

// #438: the operator API may not reach the secret store (src/operator-api/no-operator-keys.test.ts), so it cannot ask
// `isBillingOn`, which checks that the Paddle secrets can be read. It asks the switch itself: billing owns the default
// entitlements as long as the switch is on, whatever the state of the credentials.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { isBillingSwitchedOn } from "./switch.ts";

describe("the billing switch", () => {
  // #438-T06
  it("is off without a setting and reads no secret", async () => {
    const { db } = await createTestDatabase();

    expect(await isBillingSwitchedOn(db)).toBe(false);
  });

  // #438-T06
  it("follows the enabled flag of the billing settings", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);
    const base = {
      environment: "sandbox" as const,
      clientToken: "",
      graceDays: 7,
    };

    await settings.set("billing_settings", { ...base, enabled: false }, null);
    expect(await isBillingSwitchedOn(db)).toBe(false);
    await settings.set("billing_settings", { ...base, enabled: true }, null);
    expect(await isBillingSwitchedOn(db)).toBe(true);
  });
});
