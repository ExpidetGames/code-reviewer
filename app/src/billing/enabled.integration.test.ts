// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { guardBillingRoute, isBillingOn } from "./enabled.ts";

describe("whether billing is on", () => {
  // #491-T09
  it("is off without a setting", async () => {
    const { db } = await createTestDatabase();

    expect(await isBillingOn(db)).toBe(false);
  });

  // #491-T09
  it("is on only when the setting says enabled true", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);

    // The stored value is data of any shape: read it as it is, whatever it was written as.
    const cases: Array<[unknown, boolean]> = [
      [{ enabled: false }, false],
      [{ enabled: "true" }, false],
      [{ enabled: 1 }, false],
      [{ enabled: true }, true],
      // An old shape, written by a database that ran the removed subscription design: the extra fields are ignored.
      [
        {
          environment: "sandbox",
          clientToken: "test_0123456789abcdef0123456789a",
          graceDays: 7,
          enabled: true,
        },
        true,
      ],
      [
        {
          environment: "sandbox",
          clientToken: "test_0123456789abcdef0123456789a",
          graceDays: 7,
          enabled: "true",
        },
        false,
      ],
    ];
    for (const [stored, expected] of cases) {
      await settings.set("billing_settings", stored as never, null);
      expect(await isBillingOn(db), JSON.stringify(stored)).toBe(expected);
    }
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
