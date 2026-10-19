// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { canSwitchBillingOn } from "./rates.ts";
import { createBillingRatesService } from "./rates-service.ts";

const ENGINES: Array<{
  name: string;
  open: () => Promise<Kysely<Database>>;
  skip: boolean;
}> = [
  {
    name: "SQLite",
    open: async () => (await createTestDatabase()).db,
    skip: false,
  },
  {
    name: "Postgres",
    open: async () => (await createPostgresTestDatabase()).db,
    skip: !hasPostgres(),
  },
];

// Made-up numbers.
const COMPLETE = {
  factorA: 12_000,
  minuteRateMicroUsd: { diff: 10_000, dynamic: 25_000 },
  diffAiReserveMicroUsd: 300_000,
};

async function storedText(db: Kysely<Database>): Promise<string | undefined> {
  const row = await db
    .selectFrom("instance_settings")
    .select("value")
    .where("key", "=", "billing_settings")
    .executeTakeFirst();
  return row?.value;
}

function numbersIn(value: unknown): unknown[] {
  if (typeof value === "number") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(numbersIn);
}

describe.each(ENGINES)("the billing rates on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  // #494-T11
  it_(
    "reads as not set when nothing was saved, and billing cannot be switched on",
    async () => {
      const db = await engine.open();
      const service = createBillingRatesService(db);

      expect(await service.rates()).toBeNull();
      expect(await service.settings()).toStrictEqual({ enabled: false });
      expect(canSwitchBillingOn(await service.settings())).toStrictEqual({
        ok: false,
        code: "billing_rates_incomplete",
      });
      expect(await storedText(db)).toBeUndefined();
    },
  );

  // #494-T10
  it_(
    "stores what it validated, and the rates are complete once A, both rates and the Diff AI reserve are there",
    async () => {
      const db = await engine.open();
      const service = createBillingRatesService(db);

      expect(await service.update({ factorA: 12_000 }, null)).toMatchObject({
        ok: true,
      });
      expect(await service.rates()).toBeNull();
      expect(
        await service.update({ minuteRateMicroUsd: { diff: 10_000 } }, null),
      ).toMatchObject({ ok: true });
      expect(await service.rates()).toBeNull();
      expect(
        await service.update({ minuteRateMicroUsd: { dynamic: 25_000 } }, null),
      ).toMatchObject({ ok: true });
      // The reserve has no default: A and both B alone are not enough.
      expect(await service.rates()).toBeNull();
      expect(canSwitchBillingOn(await service.settings())).toStrictEqual({
        ok: false,
        code: "billing_rates_incomplete",
      });
      expect(
        await service.update({ diffAiReserveMicroUsd: 300_000 }, null),
      ).toMatchObject({ ok: true });

      expect(await service.settings()).toStrictEqual({
        enabled: false,
        ...COMPLETE,
      });
      expect(await service.rates()).toStrictEqual(COMPLETE);
      expect(canSwitchBillingOn(await service.settings())).toStrictEqual({
        ok: true,
      });
    },
  );

  // #494-T10
  it_("keeps what was stored when a change is refused", async () => {
    const db = await engine.open();
    const service = createBillingRatesService(db);
    await service.update(COMPLETE, null);
    const before = await storedText(db);
    expect(before).toBeDefined();

    const refused = [
      [{ factorA: 9_999 }, "factor_invalid"],
      [{ factorA: 12_000.5 }, "factor_invalid"],
      [{ factorA: "12000" }, "factor_invalid"],
      [{ minuteRateMicroUsd: { diff: -1 } }, "rate_invalid"],
      [{ minuteRateMicroUsd: { dynamic: 1.5 } }, "rate_invalid"],
      [{ minuteRateMicroUsd: { diff: "10000" } }, "rate_invalid"],
      [{ diffAiReserveMicroUsd: -1 }, "reserve_invalid"],
      // One wrong field refuses the whole change: the valid factor is not written either.
      [{ factorA: 20_000, diffAiReserveMicroUsd: "x" }, "reserve_invalid"],
    ] as const;
    for (const [patch, code] of refused) {
      expect(
        await service.update(patch, null),
        JSON.stringify(patch),
      ).toMatchObject({
        ok: false,
        code,
      });
      expect(await storedText(db)).toBe(before);
    }
  });

  // #494-T10
  it_("stores integers only", async () => {
    const db = await engine.open();
    const service = createBillingRatesService(db);
    await service.update(COMPLETE, null);
    await service.update({ factorA: 12_000.5 }, null);

    const numbers = numbersIn(JSON.parse((await storedText(db)) ?? "null"));
    expect(numbers.length).toBeGreaterThan(0);
    for (const number of numbers)
      expect(Number.isSafeInteger(number)).toBe(true);
  });

  // #494-T10
  it_(
    "leaves the switch alone: a change of the rates neither sets nor clears it",
    async () => {
      const db = await engine.open();
      const settings = createInstanceSettingsRepository(db);
      const service = createBillingRatesService(db);
      await settings.set("billing_settings", { enabled: true }, null);

      await service.update({ ...COMPLETE, enabled: false }, null);

      expect((await service.settings()).enabled).toBe(true);
      expect(await service.rates()).toMatchObject({ factorA: 12_000 });
    },
  );

  // #494-T10
  it_("records who changed it", async () => {
    const db = await engine.open();
    const userId = await insertUser(db, { id: "user-494" });
    const service = createBillingRatesService(db);

    await service.update({ factorA: 12_000 }, userId);

    const meta =
      await createInstanceSettingsRepository(db).getWithMeta(
        "billing_settings",
      );
    expect(meta?.updatedBy).toBe(userId);
  });

  // #494-T11
  it_.each([
    ["not an object", "junk"],
    ["an array", [1, 2]],
    ["a number", 7],
    [
      "damaged fields",
      { enabled: true, factorA: "12000", minuteRateMicroUsd: "free" },
    ],
    [
      "a float factor",
      {
        enabled: true,
        factorA: 12_000.5,
        minuteRateMicroUsd: { diff: 1, dynamic: 1 },
      },
    ],
    [
      "a negative rate",
      {
        enabled: true,
        factorA: 12_000,
        minuteRateMicroUsd: { diff: -1, dynamic: 1 },
      },
    ],
  ])("reads a stored value that is %s as not set", async (_name, stored) => {
    const db = await engine.open();
    await createInstanceSettingsRepository(db).set(
      "billing_settings",
      stored as never,
      null,
    );
    const service = createBillingRatesService(db);

    expect(await service.rates()).toBeNull();
    expect(canSwitchBillingOn(await service.settings())).toMatchObject({
      ok: false,
      code: "billing_rates_incomplete",
    });
  });

  // #494-T11
  it_("reads stored text that is no JSON at all as not set", async () => {
    const db = await engine.open();
    await db
      .insertInto("instance_settings")
      .values({
        key: "billing_settings",
        value: "{not json",
        updated_by: null,
        updated_at: "2026-10-19T00:00:00.000Z",
      })
      .execute();
    const service = createBillingRatesService(db);

    expect(await service.rates()).toBeNull();
    expect(await service.settings()).toStrictEqual({ enabled: false });
  });

  // #494-T11
  it_(
    "lets a database error through: rates that cannot be read are not rates that are not set",
    async () => {
      const db = await engine.open();
      const service = createBillingRatesService(db);
      await service.update(COMPLETE, null);
      await db.destroy();

      await expect(service.rates()).rejects.toThrow();
      await expect(service.settings()).rejects.toThrow();
    },
  );

  // #494-T11
  it_("repairs a damaged stored value with the next valid write", async () => {
    const db = await engine.open();
    await createInstanceSettingsRepository(db).set(
      "billing_settings",
      "junk" as never,
      null,
    );
    const service = createBillingRatesService(db);

    expect(await service.update(COMPLETE, null)).toMatchObject({ ok: true });

    expect(await service.settings()).toStrictEqual({
      enabled: false,
      ...COMPLETE,
    });
  });

  // #494-T10
  it_(
    "loses no change when two writers save different fields at the same time",
    async () => {
      const db = await engine.open();
      const service = createBillingRatesService(db);

      await Promise.all([
        service.update({ factorA: 12_000 }, null),
        service.update({ minuteRateMicroUsd: { diff: 10_000 } }, null),
        service.update({ minuteRateMicroUsd: { dynamic: 25_000 } }, null),
        service.update({ diffAiReserveMicroUsd: 300_000 }, null),
      ]);

      expect(await service.rates()).toStrictEqual(COMPLETE);
    },
  );
});
