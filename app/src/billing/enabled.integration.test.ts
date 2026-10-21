// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createSecretsRepository } from "../db/repositories/secrets-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  guardBillingRoute,
  isBillingOn,
  readBillingSwitch,
} from "./enabled.ts";

const RATES = {
  factorA: 50_000,
  minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
  diffAiReserveMicroUsd: 150_000,
};

describe("whether billing is on", () => {
  // #491-T09
  it("is off without a setting", async () => {
    const { db } = await createTestDatabase();

    expect(await isBillingOn(db)).toBe(false);
  });

  // #491-T09
  it("is on only when the setting says enabled true, with the manual adapter's rates set", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);

    // The stored value is data of any shape: read it as it is, whatever it was written as.
    const cases: Array<[unknown, boolean]> = [
      [{ enabled: false, ...RATES }, false],
      [{ enabled: "true", ...RATES }, false],
      [{ enabled: 1, ...RATES }, false],
      [{ enabled: true, ...RATES }, true],
      // An old shape, written by a database that ran the removed subscription design: the extra fields are ignored.
      [
        {
          environment: "sandbox",
          clientToken: "test_0123456789abcdef0123456789a",
          graceDays: 7,
          enabled: true,
          ...RATES,
        },
        true,
      ],
      [
        {
          environment: "sandbox",
          clientToken: "test_0123456789abcdef0123456789a",
          graceDays: 7,
          enabled: "true",
          ...RATES,
        },
        false,
      ],
    ];
    for (const [stored, expected] of cases) {
      await settings.set("billing_settings", stored as never, null);
      expect(await isBillingOn(db), JSON.stringify(stored)).toBe(expected);
    }
  });

  // #504-T04
  it("is off while the switch is on but a rate is missing", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);

    for (const incomplete of [
      {},
      { factorA: 50_000 },
      { ...RATES, minuteRateMicroUsd: { diff: 13_000 } },
      { ...RATES, diffAiReserveMicroUsd: undefined },
    ]) {
      await settings.set(
        "billing_settings",
        { enabled: true, ...incomplete } as never,
        null,
      );
      expect(await isBillingOn(db), JSON.stringify(incomplete)).toBe(false);
    }
  });

  // #504-T03
  it("is on with Stripe only when both credentials are stored and a connection check passed", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);
    const secrets = createSecretsRepository(db);
    const stripe = {
      checkedAt: "2026-10-20T10:00:00.000Z",
      checkedEnvironment: "test",
    };
    const stored = { enabled: true, adapter: "stripe", ...RATES, stripe };
    const row = (name: string) => ({
      name,
      ciphertext: "c",
      nonce: "n",
      keyVersion: 1,
      lastFour: null,
      updatedBy: null,
    });

    await settings.set("billing_settings", stored as never, null);
    expect(await isBillingOn(db), "no credential").toBe(false);
    await secrets.put(row("stripe_api_key"));
    expect(await isBillingOn(db), "no webhook secret").toBe(false);
    await secrets.put(row("stripe_webhook_secret"));
    expect(await isBillingOn(db), "both stored, a check passed").toBe(true);
    await settings.set(
      "billing_settings",
      { ...stored, stripe: undefined } as never,
      null,
    );
    expect(await isBillingOn(db), "no passing check").toBe(false);
  });

  // #504-T04
  it("says what is missing while the switch is on, without turning billing on", async () => {
    const { db } = await createTestDatabase();
    await createInstanceSettingsRepository(db).set(
      "billing_settings",
      { enabled: true, adapter: "stripe", factorA: 50_000 } as never,
      null,
    );

    const state = await readBillingSwitch(db);

    expect(state.enabled).toBe(true);
    expect(state.missing).toContain("minute_rate_diff_missing");
    expect(state.missing).toContain("stripe_api_key_missing");
    expect(await isBillingOn(db)).toBe(false);
  });
});

describe("the guard of a billing route", () => {
  const notFound = (): never => {
    throw new Error("NEXT_NOT_FOUND");
  };

  // #491-T09
  it("answers the missing path while billing is off, before the handler runs", async () => {
    let ran = false;
    const guarded = guardBillingRoute(
      { isOn: () => Promise.resolve(false), notFound },
      () => {
        ran = true;
        return Promise.resolve(new Response("ok"));
      },
    );

    await expect(guarded()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(ran).toBe(false);
  });

  // #491-T09
  it("runs the handler while billing is on", async () => {
    const guarded = guardBillingRoute(
      { isOn: () => Promise.resolve(true), notFound },
      () => Promise.resolve(new Response("ok")),
    );

    expect(await (await guarded()).text()).toBe("ok");
  });
});
