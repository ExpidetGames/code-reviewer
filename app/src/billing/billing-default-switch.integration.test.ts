// SPDX-License-Identifier: Apache-2.0

// The billing switch and the default entitlements it owns (#438, review of #462: N2, N3), on a real SQLite file and, when
// TEST_DATABASE_URL is set, on a real Postgres. One rule: a default that carries `source: billing` never outlives a
// switched off billing, whichever way the switch and the seeding interleave, fail or crash. The switch and the seeding
// of the Free plan are one transaction, switching off removes the billing default in the transaction that flips the
// switch, and the writer of the billing default reads the switch under the same lock before it writes.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createInstanceSettingsRepository,
  type InstanceSettingsRepository,
} from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import {
  TEST_BILLING_SETTINGS,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { planEntitlements } from "./plan-entitlements.ts";
import type { PaddleClient } from "./paddle-client.ts";
import { createBillingPlansService } from "./plans-service.ts";
import {
  createBillingSettingsService,
  type BillingSettingsServiceOptions,
} from "./settings-service.ts";
import { isBillingSwitchedOn } from "./switch.ts";
import type { SecretStore } from "../secrets/store.ts";

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

const NOW = new Date("2026-10-18T10:00:00.000Z");
const ADMIN = "admin-1";

/** Only what the switch reads: a key and a webhook secret that are there, and a client that answers the check. */
const SECRETS = {
  use: () =>
    Promise.resolve({
      ok: true,
      value: { reveal: () => "pdl_sdbx_apikey_fake_key_for_tests" },
    }),
  status: () => Promise.resolve({ state: "configured", lastFour: "abcd" }),
} as unknown as SecretStore;
// A client that lets the connection check through; no request leaves the test.
const CLIENT = {
  listProducts: () => Promise.resolve({ data: [] }),
} as unknown as PaddleClient;

type Plans = NonNullable<BillingSettingsServiceOptions["plans"]>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start(engine: (typeof ENGINES)[number]) {
  const db = await engine.open();
  await insertUser(db, { id: ADMIN, isInstanceAdmin: true });
  // Configured, not switched on: what the admin has before the button.
  await createInstanceSettingsRepository(db).set(
    "billing_settings",
    { ...TEST_BILLING_SETTINGS, enabled: false },
    null,
  );
  const plans = createBillingPlansService({ db, now: () => NOW });
  const settings = createInstanceSettingsRepository(db, () => NOW);
  const service = (using: Plans = plans) =>
    createBillingSettingsService({
      db,
      secrets: SECRETS,
      clientFor: () => CLIENT,
      publicUrl: "https://reviews.example.test",
      plans: using,
    });
  return { db, plans, settings, service };
}

type Started = Awaited<ReturnType<typeof start>>;

/** The state every test ends in: billing off never leaves a default that billing wrote. */
async function state({ db, settings }: Started) {
  const stored = await settings.getDefaultEntitlements();
  return {
    on: await isBillingSwitchedOn(db),
    source:
      stored !== undefined && "source" in stored ? stored.source : undefined,
    stored,
  };
}

function expectNoBillingDefaultWhileOff(
  seen: Awaited<ReturnType<typeof state>>,
) {
  if (!seen.on) expect(seen.source).toBeUndefined();
}

function freeEntitlements() {
  return planEntitlements({
    name: "Free",
    terms: {
      keyMode: "managed",
      limits: {
        diffRunsPerPeriod: 10,
        dynamicRunsPerPeriod: 2,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: null,
      },
      modelAccess: { catalogEntries: [] },
      monthlyAmountMinor: null,
      yearlyAmountMinor: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
  });
}

describe.each(ENGINES)(
  "the billing default and the switch on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;

    // #438-N2
    it_(
      "writes no billing default while the switch is off, and reports it",
      async () => {
        const started = await start(engine);

        const written = await started.settings.setBillingDefaultEntitlements(
          freeEntitlements(),
          null,
        );

        expect(written).toBe(false);
        expect(await started.settings.getDefaultEntitlements()).toBeUndefined();
      },
    );

    // #438-N2
    it_(
      "writes no billing default when billing was never configured",
      async () => {
        const started = await start(engine);
        await started.settings.remove("billing_settings");

        expect(
          await started.settings.setBillingDefaultEntitlements(
            freeEntitlements(),
            null,
          ),
        ).toBe(false);
        expect(await started.settings.getDefaultEntitlements()).toBeUndefined();
      },
    );

    // #438-N2
    it_("writes the billing default while the switch is on", async () => {
      const started = await start(engine);
      await setBillingSwitch(started.db, true);

      expect(
        await started.settings.setBillingDefaultEntitlements(
          freeEntitlements(),
          null,
        ),
      ).toBe(true);
      expect(await started.settings.getDefaultEntitlements()).toMatchObject({
        source: "billing",
      });
    });

    // #438-N2
    it_(
      "leaves billing off with no billing default when a switch-off comes in between the flip and the seeding of an enable",
      async () => {
        const started = await start(engine);
        const switchedOff: Array<Promise<unknown>> = [];
        const disabler = started.service();
        const racing: Plans = {
          enable: async (adminId, executor) => {
            // The other admin presses "off" as the seeding starts, and has time to get as far as it can.
            switchedOff.push(disabler.setEnabled(ADMIN, false));
            await sleep(150);
            return started.plans.enable(adminId, executor);
          },
          release: (executor) => started.plans.release(executor),
        };

        const result = await started.service(racing).setEnabled(ADMIN, true);
        await Promise.all(switchedOff);

        expect(result).toEqual({ ok: true });
        const seen = await state(started);
        expectNoBillingDefaultWhileOff(seen);
        // The off came after the on in the one order the lock allows: billing is off and nothing of it is left.
        expect(seen).toMatchObject({ on: false, stored: undefined });
      },
    );

    // #438-N2
    it_(
      "keeps billing on with its default when a repeated enable fails, instead of leaving the default behind a switch that went off",
      async () => {
        const started = await start(engine);
        expect(await started.service().setEnabled(ADMIN, true)).toEqual({
          ok: true,
        });
        const before = await state(started);
        expect(before).toMatchObject({ on: true, source: "billing" });
        const failing: Plans = {
          enable: () => Promise.reject(new Error("The seeding failed.")),
          release: (executor) => started.plans.release(executor),
        };

        await expect(
          started.service(failing).setEnabled(ADMIN, true),
        ).rejects.toThrow("The seeding failed.");

        const seen = await state(started);
        expectNoBillingDefaultWhileOff(seen);
        expect(seen).toEqual(before);
      },
    );

    // #438-N2
    it_(
      "does not switch billing on when the first seeding fails, and leaves no plan and no default",
      async () => {
        const started = await start(engine);
        const failing: Plans = {
          enable: async (adminId, executor) => {
            await started.plans.enable(adminId, executor);
            throw new Error("The process ended after the seeding.");
          },
          release: (executor) => started.plans.release(executor),
        };

        await expect(
          started.service(failing).setEnabled(ADMIN, true),
        ).rejects.toThrow("The process ended");

        expect(await state(started)).toMatchObject({
          on: false,
          stored: undefined,
        });
        expect((await started.plans.view()).plans).toEqual([]);
      },
    );

    // #438-N2
    it_(
      "keeps the switch on when removing the billing default fails, instead of switching off with the default behind",
      async () => {
        const started = await start(engine);
        expect(await started.service().setEnabled(ADMIN, true)).toEqual({
          ok: true,
        });
        const crashing: Plans = {
          enable: (adminId, executor) =>
            started.plans.enable(adminId, executor),
          release: () => Promise.reject(new Error("The process ended.")),
        };

        await expect(
          started.service(crashing).setEnabled(ADMIN, false),
        ).rejects.toThrow("The process ended.");

        const seen = await state(started);
        expectNoBillingDefaultWhileOff(seen);
        expect(seen).toMatchObject({ on: true, source: "billing" });
      },
    );

    // #438-N2
    it_(
      "removes the billing default with the switch, in one step",
      async () => {
        const started = await start(engine);
        await started.service().setEnabled(ADMIN, true);

        expect(await started.service().setEnabled(ADMIN, false)).toEqual({
          ok: true,
        });

        expect(await state(started)).toMatchObject({
          on: false,
          stored: undefined,
        });
      },
    );

    // #438-N2
    it_(
      "removes a billing default that a billing that is already off left behind, when it is switched off again",
      async () => {
        const started = await start(engine);
        // The state the review described: the switch is off and the marker is still there.
        await setBillingSwitch(started.db, true);
        await started.settings.setBillingDefaultEntitlements(
          freeEntitlements(),
          null,
        );
        await setBillingSwitch(started.db, false);
        expect((await state(started)).source).toBe("billing");

        expect(await started.service().setEnabled(ADMIN, false)).toEqual({
          ok: true,
        });

        expect((await state(started)).stored).toBeUndefined();
      },
    );

    // #438-N2
    it_(
      "leaves a default of the operator alone when billing is switched off",
      async () => {
        const started = await start(engine);
        await started.settings.set(
          "default_entitlements",
          {
            ...freeEntitlements(),
            planLabel: "Operator",
          },
          null,
        );
        await setBillingSwitch(started.db, true);

        expect(await started.service().setEnabled(ADMIN, false)).toEqual({
          ok: true,
        });

        expect((await state(started)).stored).toMatchObject({
          planLabel: "Operator",
        });
      },
    );
  },
);

const describePostgres = hasPostgres() ? describe : describe.skip;

describePostgres("the billing switch and its seeding on Postgres", () => {
  // #438-N2
  it("does not show the switch on to anybody before the Free plan is seeded and the default is written", async () => {
    const postgres = {
      name: "Postgres",
      open: async () => (await createPostgresTestDatabase()).db,
      skip: false,
    };
    const started = await start(postgres);
    let seenWhileSeeding: boolean | undefined;
    const watching: Plans = {
      enable: async (adminId, executor) => {
        // Another connection, as another app instance: the pool, not the transaction that is seeding.
        seenWhileSeeding = await isBillingSwitchedOn(started.db);
        return started.plans.enable(adminId, executor);
      },
      release: (executor) => started.plans.release(executor),
    };

    await started.service(watching).setEnabled(ADMIN, true);

    // A crash here would leave no switch and no half of it: the flip and the seeding commit together.
    expect(seenWhileSeeding).toBe(false);
    expect(await state(started)).toMatchObject({ on: true, source: "billing" });
  });

  // #438-N3
  it("makes a write of the operator that arrives while billing is being switched on wait for the switch, and refuses it", async () => {
    const postgres = {
      name: "Postgres",
      open: async () => (await createPostgresTestDatabase()).db,
      skip: false,
    };
    const started = await start(postgres);
    const operatorWrites: Array<Promise<boolean>> = [];
    const racing: Plans = {
      enable: async (adminId, executor) => {
        // The write passed its check before the switch was on and reaches the database while the seeding runs.
        operatorWrites.push(
          started.settings.setDefaultEntitlementsUnlessBilling(
            { ...freeEntitlements(), planLabel: "Operator" },
            null,
          ),
        );
        await sleep(150);
        return started.plans.enable(adminId, executor);
      },
      release: (executor) => started.plans.release(executor),
    };

    await started.service(racing).setEnabled(ADMIN, true);

    expect(await Promise.all(operatorWrites)).toEqual([false]);
    expect(await state(started)).toMatchObject({ on: true, source: "billing" });
    expect((await state(started)).stored).toMatchObject({ planLabel: "Free" });
  });

  // #438-N2
  it("settles any number of enables and disables that overlap into a state that has no billing default behind a switch that is off", async () => {
    const postgres = {
      name: "Postgres",
      open: async () => (await createPostgresTestDatabase()).db,
      skip: false,
    };
    const started = await start(postgres);

    for (let round = 0; round < 8; round += 1) {
      await Promise.all([
        started.service().setEnabled(ADMIN, true),
        started.service().setEnabled(ADMIN, false),
        started.service().setEnabled(ADMIN, true),
        started.service().setEnabled(ADMIN, false),
      ]);
      const seen = await state(started);
      expectNoBillingDefaultWhileOff(seen);
      if (seen.on) expect(seen.source).toBe("billing");
    }
  });
});
