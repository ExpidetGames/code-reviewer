// SPDX-License-Identifier: Apache-2.0

// The cache of linked Paddle prices (#439, ADR 0005, 2.11) on a real SQLite file and, when TEST_DATABASE_URL is set, on a real
// Postgres: one row per Paddle price, the product a plan is bound to, and the two price links of a version. Instance level.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { PlanTerms } from "../../admin/ui/plans-view.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import type { Database } from "../schema.ts";
import { createBillingPlansRepository } from "./billing-plans-repository.ts";
import { createBillingPlanVersionsRepository } from "./billing-plan-versions-repository.ts";
import {
  PriceTakenError,
  createBillingPlanPricesRepository,
  type PriceSnapshot,
} from "./billing-plan-prices-repository.ts";

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

const T0 = new Date("2026-10-18T10:00:00.000Z");

const TERMS: PlanTerms = {
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 40,
    dynamicRunsPerPeriod: 8,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  modelAccess: { catalogEntries: null },
  monthlyAmountMinor: 1234,
  yearlyAmountMinor: 12_340,
};

function snapshot(overrides: Partial<PriceSnapshot> = {}): PriceSnapshot {
  return {
    productId: "pro_01fake1",
    priceType: "standard",
    interval: "month",
    frequency: 1,
    currency: "USD",
    amount: "1234",
    taxMode: "internal",
    hasOverrides: false,
    trialDays: null,
    status: "active",
    quantityMinimum: 1,
    quantityMaximum: 100,
    ...overrides,
  };
}

describe.each(ENGINES)("the billing plan prices on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  async function start() {
    const db = await engine.open();
    let now = T0;
    let counter = 0;
    const plans = createBillingPlansRepository(
      db,
      () => now,
      () => `bpl_${++counter}`,
    );
    const versions = createBillingPlanVersionsRepository(
      db,
      () => now,
      () => `bpv_${++counter}`,
    );
    const prices = createBillingPlanPricesRepository(
      db,
      () => now,
      () => `bpp_${++counter}`,
    );
    const metadata = {
      name: "Team",
      description: "",
      sort: 1,
      offered: true,
      popular: false,
      contactTarget: null,
    };
    const plan = await plans.insert(
      { planKey: "team", kind: "paid", metadata },
      null,
    );
    const other = await plans.insert(
      { planKey: "pro", kind: "paid", metadata: { ...metadata, name: "Pro" } },
      null,
    );
    const version = await versions.createNext(plan.id, TERMS, null, 0);
    return {
      db,
      plans,
      versions,
      prices,
      plan,
      other,
      version,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  // #439-T01
  it_(
    "stores a linked price with what Paddle said and reads it back by id and by Paddle id",
    async () => {
      const { prices, plan } = await start();

      const stored = await prices.insertLinked({
        planId: plan.id,
        paddlePriceId: "pri_01fake1",
        env: "sandbox",
        snapshot: snapshot({ trialDays: 14 }),
      });

      expect(stored).toMatchObject({
        planId: plan.id,
        paddlePriceId: "pri_01fake1",
        productId: "pro_01fake1",
        env: "sandbox",
        interval: "month",
        frequency: 1,
        currency: "USD",
        amount: "1234",
        taxMode: "internal",
        hasOverrides: false,
        trialDays: 14,
        status: "active",
        origin: "linked",
        state: "ready",
        snapshotAt: T0.toISOString(),
      });
      expect(await prices.get(stored.id)).toEqual(stored);
      expect(await prices.getByPaddleId("pri_01fake1")).toEqual(stored);
      expect(await prices.getByPaddleId("pri_unknown")).toBeUndefined();
      expect(await prices.listForPlan(plan.id)).toEqual([stored]);
    },
  );

  // #439-T06
  it_(
    "refuses a second row for the same Paddle price, whichever plan asks",
    async () => {
      const { prices, plan, other } = await start();
      await prices.insertLinked({
        planId: plan.id,
        paddlePriceId: "pri_01fake1",
        env: "sandbox",
        snapshot: snapshot(),
      });

      await expect(
        prices.insertLinked({
          planId: other.id,
          paddlePriceId: "pri_01fake1",
          env: "sandbox",
          snapshot: snapshot(),
        }),
      ).rejects.toBeInstanceOf(PriceTakenError);
      expect(await prices.listForPlan(other.id)).toEqual([]);
    },
  );

  // #439-T04
  it_(
    "replaces what it cached with a new answer and changes nothing else",
    async () => {
      const { prices, plan, advance } = await start();
      const stored = await prices.insertLinked({
        planId: plan.id,
        paddlePriceId: "pri_01fake1",
        env: "sandbox",
        snapshot: snapshot(),
      });
      advance(60_000);

      const refreshed = await prices.refresh(
        stored.id,
        snapshot({
          amount: "9999",
          status: "archived",
          trialDays: 7,
          quantityMinimum: 2,
          quantityMaximum: 9,
          priceType: "custom",
        }),
      );

      expect(refreshed).toMatchObject({
        id: stored.id,
        planId: plan.id,
        paddlePriceId: "pri_01fake1",
        origin: "linked",
        amount: "9999",
        status: "archived",
        trialDays: 7,
        quantityMinimum: 2,
        quantityMaximum: 9,
        priceType: "custom",
        snapshotAt: new Date(T0.getTime() + 60_000).toISOString(),
        createdAt: stored.createdAt,
      });
      expect(await prices.get(stored.id)).toEqual(refreshed);
    },
  );

  // #439-T17
  it_(
    "keeps an amount of any size whole and refuses text that is not minor units",
    async () => {
      const { prices, plan } = await start();

      const big = await prices.insertLinked({
        planId: plan.id,
        paddlePriceId: "pri_big",
        env: "sandbox",
        snapshot: snapshot({ amount: "99999999999999999999" }),
      });

      expect(big.amount).toBe("99999999999999999999");
      for (const amount of ["12.5", "", "1e3", "-1", " 12"])
        await expect(
          prices.insertLinked({
            planId: plan.id,
            paddlePriceId: `pri_bad_${amount.length}`,
            env: "sandbox",
            snapshot: snapshot({ amount }),
          }),
          amount,
        ).rejects.toThrow();
      await expect(
        prices.refresh(big.id, snapshot({ amount: "1.0" })),
      ).rejects.toThrow();
      // Review of #468, N2: the quantity limits are whole numbers from one up.
      for (const [quantityMinimum, quantityMaximum] of [
        [0, 5],
        [1, 0],
        [1.5, 3],
      ] as const)
        await expect(
          prices.refresh(
            big.id,
            snapshot({ quantityMinimum, quantityMaximum }),
          ),
        ).rejects.toThrow();
    },
  );

  // #439-T01
  it_(
    "binds a plan to its Paddle product once and then answers with the one it has",
    async () => {
      const { plans, plan, advance } = await start();
      advance(1000);

      const first = await plans.bindProduct(plan.id, "pro_01fake1", "sandbox");
      advance(1000);
      const second = await plans.bindProduct(plan.id, "pro_other", "live");

      expect(first).toEqual({ productId: "pro_01fake1", env: "sandbox" });
      expect(second).toEqual({ productId: "pro_01fake1", env: "sandbox" });
      const stored = await plans.get("team");
      expect(stored).toMatchObject({
        paddleProductId: "pro_01fake1",
        paddleProductEnv: "sandbox",
        // Binding the product is not an edit of the display fields: a form that was open is not made stale by it.
        updatedAt: T0.toISOString(),
      });
      expect(await plans.get("pro")).toMatchObject({
        paddleProductId: null,
        paddleProductEnv: null,
      });
    },
  );

  // #439-T01
  it_(
    "links a version to a price per slot and reads the links back; a link is set and replaced",
    async () => {
      const { prices, versions, plan, version } = await start();
      const monthly = await prices.insertLinked({
        planId: plan.id,
        paddlePriceId: "pri_m",
        env: "sandbox",
        snapshot: snapshot(),
      });
      const yearly = await prices.insertLinked({
        planId: plan.id,
        paddlePriceId: "pri_y",
        env: "sandbox",
        snapshot: snapshot({ interval: "year", amount: "12340" }),
      });
      expect(version).toMatchObject({
        monthlyPriceId: null,
        yearlyPriceId: null,
      });

      await versions.setPriceLink(version.id, "month", monthly.id, null);
      await versions.setPriceLink(version.id, "year", yearly.id, null);

      expect(await versions.current(plan.id)).toMatchObject({
        monthlyPriceId: monthly.id,
        yearlyPriceId: yearly.id,
        monthlyAmountMinor: 1234,
        yearlyAmountMinor: 12_340,
      });

      await versions.setPriceLink(version.id, "month", yearly.id, monthly.id);

      expect(await versions.current(plan.id)).toMatchObject({
        monthlyPriceId: yearly.id,
        yearlyPriceId: yearly.id,
      });
    },
  );

  // #439-T05
  it_("lets two versions share one price", async () => {
    const { prices, versions, plan, version } = await start();
    const shared = await prices.insertLinked({
      planId: plan.id,
      paddlePriceId: "pri_m",
      env: "sandbox",
      snapshot: snapshot(),
    });
    // Linked while the version is the current one; a legacy version is never linked any more.
    await versions.setPriceLink(version.id, "month", shared.id, null);
    const next = await versions.createNext(
      plan.id,
      { ...TERMS, limits: { ...TERMS.limits, diffRunsPerPeriod: 50 } },
      null,
      1,
    );
    await versions.setPriceLink(next.id, "month", shared.id, null);

    const all = await versions.list(plan.id);
    expect(all.map((candidate) => candidate.monthlyPriceId)).toEqual([
      shared.id,
      shared.id,
    ]);
  });

  it_(
    "refuses a link to a row that is not there and a slot that is not month or year",
    async () => {
      const { versions, version } = await start();

      await expect(
        versions.setPriceLink(version.id, "month", "bpp_nope", null),
      ).rejects.toThrow();
      await expect(
        versions.setPriceLink(version.id, "week" as never, "bpp_nope", null),
      ).rejects.toThrow();
    },
  );
  // The database refuses what the repository merely does not offer (review of #468, N8; the pattern of #462): the identity
  // of a price row never changes, whoever writes, because versions and, later, subscriptions point at it.
  const IMMUTABLE = /billing_plan_prices_immutable/;
  // `paddle_price_id` is written once: a price the app creates (#440) has none until Paddle answers.
  const FROZEN = ["id", "plan_id", "paddle_env", "origin", "created_at"];
  const WRITE_ONCE = ["paddle_price_id"];

  // #439-T19
  it_("offers no way to change the identity of a price", async () => {
    const { prices } = await start();

    expect(Object.keys(prices).sort()).toEqual([
      "get",
      "getByPaddleId",
      "insertLinked",
      "listByIds",
      "listForPlan",
      "refresh",
    ]);
  });

  // #439-T19
  it_(
    "refuses to update an identity column, and names every column of the table as frozen, write once or mutable",
    async () => {
      const { db, prices, plan, other } = await start();
      const stored = await prices.insertLinked({
        planId: plan.id,
        paddlePriceId: "pri_1",
        env: "sandbox",
        snapshot: snapshot(),
      });
      const columns = (await db.introspection.getTables())
        .find((table) => table.name === "billing_plan_prices")
        ?.columns.map((column) => column.name);
      // The mutable ones are named here, so a column that is added later is classified by whoever adds it.
      const mutable = [
        "paddle_product_id",
        "price_type",
        "interval",
        "frequency",
        "currency",
        "unit_amount_minor",
        "tax_mode",
        "has_overrides",
        "trial_days",
        "quantity_min",
        "quantity_max",
        "paddle_status",
        "intent_id",
        "state",
        "last_error_code",
        "snapshot_at",
        "archived_at",
      ];
      expect([...(columns ?? [])].sort()).toEqual(
        [...FROZEN, ...WRITE_ONCE, ...mutable].sort(),
      );
      const read = async () =>
        (
          await sql<
            Record<string, unknown>
          >`select * from billing_plan_prices where id = ${stored.id}`.execute(
            db,
          )
        ).rows[0];
      const before = await read();

      const values: Record<string, unknown> = {
        id: "bpp_other",
        plan_id: other.id,
        paddle_env: "live",
        origin: "created",
        created_at: "2020-01-01T00:00:00.000Z",
        paddle_price_id: "pri_2",
      };
      for (const column of [...FROZEN, ...WRITE_ONCE])
        await expect(
          sql`update billing_plan_prices set ${sql.ref(column)} = ${values[column]} where id = ${stored.id}`.execute(
            db,
          ),
          column,
        ).rejects.toThrow(IMMUTABLE);
      // One frozen column among allowed ones refuses the whole statement.
      await expect(
        sql`update billing_plan_prices set unit_amount_minor = '1', plan_id = ${other.id} where id = ${stored.id}`.execute(
          db,
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        sql`update billing_plan_prices set paddle_price_id = null where id = ${stored.id}`.execute(
          db,
        ),
      ).rejects.toThrow(IMMUTABLE);

      expect(await read()).toEqual(before);
    },
  );

  // #439-T19
  it_(
    "lets every other column change, and the Paddle price id be set once on a price that has none",
    async () => {
      const { db, plan } = await start();
      await sql`insert into billing_plan_prices
      (id, plan_id, paddle_price_id, paddle_product_id, paddle_env, interval, frequency, currency, unit_amount_minor, tax_mode, has_overrides, quantity_min, quantity_max, origin, state, created_at)
      values ('bpp_pending', ${plan.id}, null, 'pro_1', 'sandbox', 'month', 1, 'USD', '1234', 'internal', 0, 1, 100, 'created', 'pending', ${T0.toISOString()})`.execute(
        db,
      );

      await sql`update billing_plan_prices set
      paddle_product_id = 'pro_2', price_type = 'custom', interval = 'year', frequency = 1, currency = 'EUR', unit_amount_minor = '99', tax_mode = 'external',
      has_overrides = 1, trial_days = 3, quantity_min = 2, quantity_max = 3, paddle_status = 'archived', intent_id = 'intent-1',
      state = 'ready', last_error_code = null, snapshot_at = ${T0.toISOString()}, archived_at = ${T0.toISOString()},
      paddle_price_id = 'pri_new'
      where id = 'bpp_pending'`.execute(db);

      const row = (
        await sql<
          Record<string, unknown>
        >`select * from billing_plan_prices where id = 'bpp_pending'`.execute(
          db,
        )
      ).rows[0];
      expect(row).toMatchObject({
        paddle_price_id: "pri_new",
        paddle_product_id: "pro_2",
        interval: "year",
        currency: "EUR",
        unit_amount_minor: "99",
        state: "ready",
        plan_id: plan.id,
        origin: "created",
      });
      await expect(
        sql`update billing_plan_prices set paddle_price_id = 'pri_again' where id = 'bpp_pending'`.execute(
          db,
        ),
      ).rejects.toThrow(IMMUTABLE);
    },
  );
});
