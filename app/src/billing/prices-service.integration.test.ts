// SPDX-License-Identifier: Apache-2.0

// Linking Paddle prices to a plan version (#439, epic #421) over a real database and the fake Paddle: the version holds the
// amounts the operator entered, a linked price must carry exactly the amount of its slot (USD, tax inclusive, the slot's
// interval, active, no overrides, the plan's product), Paddle's answer is cached, and the app only ever reads from Paddle.
// All numbers are made up.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/schema.ts";
import type { PlanView, PlanVersionView } from "../admin/ui/plans-view.ts";
import { createSecretStore } from "../secrets/store.ts";
import {
  afterQueryPlugin,
  type QueryInfo,
} from "../test-support/query-hook.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { clientFor, startTestPaddle } from "../test-support/paddle-fake.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import type { PaddleClient, PaddlePrice } from "./paddle-client.ts";
import { createBillingPlansService } from "./plans-service.ts";
import { createBillingPlanPricesRepository } from "../db/repositories/billing-plan-prices-repository.ts";
import {
  createBillingPricesService,
  snapshotOf,
  type PricesResult,
} from "./prices-service.ts";

const T0 = new Date("2026-10-18T10:00:00.000Z");
const APP_SECRET = "prices-service-test-secret-0123456789-012345";

const LIMITS = {
  diffRunsPerPeriod: 40,
  dynamicRunsPerPeriod: 8,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

function terms(overrides: Record<string, unknown> = {}) {
  return {
    keyMode: "managed",
    limits: LIMITS,
    modelAccess: { catalogEntries: null },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: 12_340,
    ...overrides,
  };
}

function plan(planKey: string, overrides: Record<string, unknown> = {}) {
  return {
    planKey,
    kind: "paid",
    name: planKey,
    description: "",
    sort: 20,
    offered: true,
    popular: false,
    contactTarget: null,
    terms: terms(),
    ...overrides,
  };
}

type PriceInput = Parameters<PaddleClient["createPrice"]>[0] & {
  /** Paddle's limits for the quantity of a transaction item; the app's client does not send them, the dashboard does. */
  quantity?: { minimum: number; maximum: number };
  unit_price_overrides?: Array<{
    country_codes: string[];
    unit_price: { amount: string; currency_code: string };
  }>;
};

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

async function startOn(open: () => Promise<Kysely<Database>>) {
  const db = await open();
  // Runs between two statements of the service's transactions (Postgres only, see `query-hook.ts`).
  let betweenStatements: ((query: QueryInfo) => Promise<void>) | undefined;
  const serviceDb = db.withPlugin(
    afterQueryPlugin(
      (query) => betweenStatements?.(query) ?? Promise.resolve(),
    ),
  );
  const admin = await insertUser(db, { id: "admin-1", isInstanceAdmin: true });
  await setBillingSwitch(db, true);
  const fake = await startTestPaddle();
  const secrets = createSecretStore({ db, appSecret: APP_SECRET });
  await secrets.save("paddle_api_key", fake.apiKey, { updatedBy: admin });
  const plans = createBillingPlansService({ db, now: () => T0 });
  const clients: PaddleClient[] = [];
  // What the dashboard cannot make but a damaged or hostile answer could: the price as the client hands it to the service.
  let rewriteAnswer: ((price: PaddlePrice) => PaddlePrice) | undefined;
  // Runs once the service has read a price and before it writes: the moment another admin can get in between.
  let afterPriceRead: (() => Promise<void>) | undefined;
  const prices = createBillingPricesService({
    db: serviceDb,
    secrets,
    now: () => T0,
    clientFor: () => {
      const real = clientFor(fake);
      const client: PaddleClient = {
        ...real,
        getPrice: async (priceId) => {
          const price = await real.getPrice(priceId);
          await afterPriceRead?.();
          return rewriteAnswer === undefined ? price : rewriteAnswer(price);
        },
      };
      clients.push(client);
      return client;
    },
  });
  const paddle = clientFor(fake);
  const product = await paddle.createProduct({
    name: "Team",
    tax_category: "standard",
  });
  expect(
    (await plans.createPlan(admin, plan("team"))).ok,
    "the plan is created",
  ).toBe(true);

  /** A price as the operator made it in the Paddle dashboard; the defaults are the right price of the monthly slot. */
  async function makePrice(
    overrides: Partial<PriceInput> = {},
    productId = product.id,
  ) {
    // `unit_price_overrides` is not a field the app's client creates; the fake takes it, as Paddle does.
    return paddle.createPrice({
      product_id: productId,
      description: "Monthly",
      unit_price: { amount: "1234", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
      tax_mode: "internal",
      ...overrides,
    } as Parameters<PaddleClient["createPrice"]>[0]);
  }
  const yearlyPrice = (overrides: Partial<PriceInput> = {}) =>
    makePrice({
      description: "Yearly",
      unit_price: { amount: "12340", currency_code: "USD" },
      billing_cycle: { interval: "year", frequency: 1 },
      ...overrides,
    });

  async function view(planKey = "team") {
    const found = (await plans.view()).plans.find(
      (candidate) => candidate.planKey === planKey,
    );
    if (found === undefined) throw new Error("no such plan");
    return found;
  }
  const current = async (planKey = "team"): Promise<PlanVersionView> => {
    const found = (await view(planKey)).versions.find(
      (version) => version.role === "current",
    );
    if (found === undefined) throw new Error("no current version");
    return found;
  };
  const link = async (
    interval: "month" | "year",
    paddlePriceId: string,
    planKey = "team",
    versionNumber?: number,
  ): Promise<PricesResult> =>
    prices.link(admin, planKey, {
      versionNumber: versionNumber ?? (await current(planKey)).number,
      interval,
      paddlePriceId,
    });
  /** What the dashboard does: the app's client refuses this, the fake does not. */
  async function editAtPaddle(priceId: string, body: Record<string, unknown>) {
    const response = await fetch(`${fake.baseUrl}/prices/${priceId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${fake.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  }
  const writesToPaddle = (since = 0) =>
    fake
      .requests()
      .slice(since)
      .filter((request) => request.method !== "GET");

  return {
    db,
    admin,
    /** `hook` runs when the service has read a price from Paddle, before it writes anything (both engines). */
    afterPriceRead: (hook: (() => Promise<void>) | undefined) => {
      afterPriceRead = hook;
    },
    /** `rewrite` changes every price the service reads from Paddle, as the client returns it. */
    rewriteAnswer: (
      rewrite: ((price: PaddlePrice) => PaddlePrice) | undefined,
    ) => {
      rewriteAnswer = rewrite;
    },
    /** `hook` runs after each statement of the service until it is replaced; it works on `db`, a connection of its own. */
    onStatement: (hook: ((query: QueryInfo) => Promise<void>) | undefined) => {
      betweenStatements = hook;
    },
    fake,
    secrets,
    plans,
    prices,
    paddle,
    product,
    makePrice,
    yearlyPrice,
    view,
    current,
    link,
    editAtPaddle,
    writesToPaddle,
    priceRows: () => db.selectFrom("billing_plan_prices").selectAll().execute(),
  };
}

function refused(result: PricesResult) {
  if (result.ok) throw new Error("expected a refusal");
  return result;
}

describe.each(ENGINES)(
  "linking Paddle prices to a plan version on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;
    // Needs two connections working at once: the hook of `query-hook.ts` cannot run on SQLite's single connection.
    const itPg = engine.name === "Postgres" && !engine.skip ? it : it.skip;
    const start = () => startOn(engine.open);

    // #439-T01
    it_(
      "links a monthly and a yearly price that carry the entered amounts, caches what Paddle says and makes the version sellable",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const yearly = await t.yearlyPrice();

        expect(await t.link("month", monthly.id)).toEqual({ ok: true });
        expect(await t.link("year", yearly.id)).toEqual({ ok: true });

        const plan: PlanView = await t.view();
        const version = await t.current();
        expect(plan.paddleProductId).toBe(t.product.id);
        expect(version.monthlyPrice).toMatchObject({
          paddlePriceId: monthly.id,
          interval: "month",
          frequency: 1,
          currency: "USD",
          taxMode: "internal",
          amount: "1234",
          status: "active",
          trialDays: null,
          snapshotAt: T0.toISOString(),
          drift: null,
        });
        expect(version.yearlyPrice).toMatchObject({
          paddlePriceId: yearly.id,
          interval: "year",
          amount: "12340",
          drift: null,
        });
        expect(version.sellable).toBe(true);
        const rows = await t.priceRows();
        expect(rows).toHaveLength(2);
        expect(
          rows.every((row) => row.origin === "linked" && row.state === "ready"),
        ).toBe(true);
        // The app only reads.
        expect(
          t
            .writesToPaddle()
            .filter(
              (request) =>
                request.path !== "/products" && request.path !== "/prices",
            ),
        ).toEqual([]);
      },
    );

    // #439-T01
    it_("caches the trial a price has and does not set one", async () => {
      const t = await start();
      const monthly = await t.makePrice({
        trial_period: { interval: "day", frequency: 14 },
      });

      expect(await t.link("month", monthly.id)).toEqual({ ok: true });

      expect((await t.current()).monthlyPrice?.trialDays).toBe(14);
    });

    // #439-T01
    it_(
      "is not sellable with only the monthly price while a yearly price is entered, and is with the monthly one when there is no yearly price",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        expect(await t.link("month", monthly.id)).toEqual({ ok: true });
        expect((await t.current()).sellable).toBe(false);

        const { admin, plans } = t;
        expect(
          (
            await plans.saveTerms(admin, "team", {
              basedOnVersion: 1,
              terms: terms({ yearlyAmountMinor: null }),
            })
          ).ok,
        ).toBe(true);
        expect(await t.link("month", monthly.id)).toEqual({ ok: true });

        const version = await t.current();
        expect(version.number).toBe(2);
        expect(version.yearlyPrice).toBeNull();
        expect(version.sellable).toBe(true);
      },
    );

    // #439-T02
    it_(
      "refuses a price that Paddle does not know with its own code and stores nothing",
      async () => {
        const t = await start();

        const result = refused(
          await t.link("month", "pri_01fake99999999999999999999"),
        );

        expect(result.code).toBe("price_not_found");
        expect(await t.priceRows()).toEqual([]);
        expect((await t.current()).monthlyPrice).toBeNull();
      },
    );

    // #439-T02
    it_(
      "refuses an archived price, a one-time price, a price with overrides and a price of another product, each with its own code",
      async () => {
        const t = await start();
        const archived = await t.makePrice();
        await t.editAtPaddle(archived.id, { status: "archived" });
        const oneTime = await t.makePrice({ billing_cycle: null });
        const overrides = await t.makePrice({
          unit_price_overrides: [
            {
              country_codes: ["DE"],
              unit_price: { amount: "1200", currency_code: "EUR" },
            },
          ],
        });
        const good = await t.makePrice();
        expect(await t.link("month", good.id)).toEqual({ ok: true });
        const otherProduct = await t.paddle.createProduct({
          name: "Other",
          tax_category: "standard",
        });
        const foreign = await t.makePrice({}, otherProduct.id);

        expect(refused(await t.link("month", archived.id)).code).toBe(
          "price_not_active",
        );
        expect(refused(await t.link("month", oneTime.id)).code).toBe(
          "price_not_recurring",
        );
        expect(refused(await t.link("month", overrides.id)).code).toBe(
          "price_has_overrides",
        );
        expect(refused(await t.link("month", foreign.id)).code).toBe(
          "price_product_mismatch",
        );
        expect(await t.priceRows()).toHaveLength(1);
      },
    );

    // #439-T18 (review of #468, N2)
    it_(
      "refuses a price that cannot be bought one at a time, and accepts one that can",
      async () => {
        const t = await start();
        const bulk = await t.makePrice({
          quantity: { minimum: 5, maximum: 10 },
        });
        const single = await t.makePrice({
          quantity: { minimum: 1, maximum: 1 },
        });
        const wide = await t.makePrice({
          quantity: { minimum: 1, maximum: 500 },
        });

        expect(refused(await t.link("month", bulk.id))).toMatchObject({
          code: "price_quantity_unsupported",
          field: "paddlePriceId",
          entered: "1",
          paddle: "5 to 10",
        });
        expect(await t.priceRows(), "the refusal stored nothing").toEqual([]);
        expect(await t.link("month", single.id)).toEqual({ ok: true });
        expect(await t.link("month", wide.id)).toEqual({ ok: true });
      },
    );

    // #439-T18 (review of #468, N2)
    it_(
      "caches the quantity and shows a drift when it changes at Paddle, until the version is linked to a price that fits",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        expect(await t.link("month", monthly.id)).toEqual({ ok: true });
        expect((await t.priceRows())[0]).toMatchObject({
          quantity_min: 1,
          quantity_max: 100,
        });

        await t.editAtPaddle(monthly.id, {
          quantity: { minimum: 2, maximum: 100 },
        });
        await t.prices.refresh("team");

        expect((await t.priceRows())[0]).toMatchObject({ quantity_min: 2 });
        expect(await t.current()).toMatchObject({
          sellable: false,
          monthlyPrice: { drift: "price_quantity_unsupported" },
        });
      },
    );

    // #439-T02
    it_(
      "refuses a price when the plan's product is from the other Paddle environment",
      async () => {
        const t = await start();
        const first = await t.makePrice();
        expect(await t.link("month", first.id)).toEqual({ ok: true });
        await t.db
          .updateTable("billing_plans")
          .set({ paddle_product_env: "live" })
          .where("plan_key", "=", "team")
          .execute();
        const second = await t.makePrice();

        expect(refused(await t.link("month", second.id)).code).toBe(
          "price_environment_mismatch",
        );
        expect(await t.priceRows()).toHaveLength(1);
      },
    );

    // #439-T03
    it_(
      "refuses a yearly price on a version without a yearly price before it asks Paddle, and stores nothing",
      async () => {
        const t = await start();
        await t.plans.createPlan(
          t.admin,
          plan("solo", { terms: terms({ yearlyAmountMinor: null }) }),
        );
        const yearly = await t.yearlyPrice();
        const asked = t.fake.requests().length;

        const result = refused(await t.link("year", yearly.id, "solo"));

        expect(result).toMatchObject({
          code: "price_yearly_not_entered",
          field: "interval",
        });
        expect(t.fake.requests().length).toBe(asked);
        expect(await t.priceRows()).toEqual([]);
        expect((await t.current("solo")).yearlyPrice).toBeNull();
      },
    );

    // #439-T04
    it_(
      "refreshes the cache from Paddle, shows a drift when the amount changed there, and sends nothing but reads",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        await t.link("month", monthly.id);
        await t.editAtPaddle(monthly.id, {
          unit_price: { amount: "1500", currency_code: "USD" },
        });
        const before = t.fake.requests().length;

        expect(await t.prices.refresh("team")).toEqual({ ok: true });

        const version = await t.current();
        expect(version.monthlyPrice).toMatchObject({
          amount: "1500",
          drift: "price_amount_mismatch",
          driftEntered: "1234",
          driftPaddle: "1500",
        });
        expect(version.sellable).toBe(false);
        expect(t.writesToPaddle(before)).toEqual([]);
        // The entered amount belongs to the version and is never touched.
        expect(version.monthlyAmountMinor).toBe(1234);
      },
    );

    // #439-T16
    it_(
      "keeps the version out of sale after a refresh that found another amount, until it is linked again to a price that fits",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const yearly = await t.yearlyPrice();
        await t.link("month", monthly.id);
        await t.link("year", yearly.id);
        expect((await t.current()).sellable).toBe(true);
        await t.editAtPaddle(yearly.id, {
          unit_price: { amount: "999", currency_code: "USD" },
        });
        const before = t.fake.requests().length;

        await t.prices.refresh("team");

        expect((await t.current()).yearlyPrice?.drift).toBe(
          "price_amount_mismatch",
        );
        expect((await t.current()).sellable).toBe(false);
        expect(t.writesToPaddle(before)).toEqual([]);

        const replacement = await t.yearlyPrice();
        expect(await t.link("year", replacement.id)).toEqual({ ok: true });

        expect((await t.current()).sellable).toBe(true);
        expect((await t.current()).yearlyPrice?.paddlePriceId).toBe(
          replacement.id,
        );
      },
    );

    // #439-T04
    it_(
      "shows an archived price, and one whose currency, interval or tax mode changed, as a drift",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        await t.link("month", monthly.id);

        for (const [body, drift] of [
          [{ status: "archived" }, "price_not_active"],
          [
            { status: "active", tax_mode: "external" },
            "price_tax_mode_mismatch",
          ],
          [
            {
              tax_mode: "internal",
              unit_price: { amount: "1234", currency_code: "EUR" },
            },
            "price_currency_mismatch",
          ],
          [
            {
              unit_price: { amount: "1234", currency_code: "USD" },
              billing_cycle: { interval: "year", frequency: 1 },
            },
            "price_interval_mismatch",
          ],
        ] as const) {
          await t.editAtPaddle(monthly.id, body);
          await t.prices.refresh("team");
          expect(
            (await t.current()).monthlyPrice?.drift,
            JSON.stringify(body),
          ).toBe(drift);
        }
        await t.editAtPaddle(monthly.id, {
          billing_cycle: { interval: "month", frequency: 1 },
        });
        await t.prices.refresh("team");
        expect((await t.current()).monthlyPrice?.drift).toBeNull();
      },
    );

    // #439-T05
    it_(
      "lets two versions of a plan share one price, with one row for it",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const yearly = await t.yearlyPrice();
        await t.link("month", monthly.id);
        await t.link("year", yearly.id);
        await t.plans.saveTerms(t.admin, "team", {
          basedOnVersion: 1,
          terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: 60 } }),
        });

        expect(await t.link("month", monthly.id)).toEqual({ ok: true });
        expect(await t.link("year", yearly.id)).toEqual({ ok: true });

        const versions = (await t.view()).versions;
        expect(
          versions.map((version) => version.monthlyPrice?.paddlePriceId),
        ).toEqual([monthly.id, monthly.id]);
        expect(await t.priceRows()).toHaveLength(2);
      },
    );

    // #439-T05
    it_("never links a version that is no longer the current one", async () => {
      const t = await start();
      const monthly = await t.makePrice();
      await t.plans.saveTerms(t.admin, "team", {
        basedOnVersion: 1,
        terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: 60 } }),
      });

      expect(refused(await t.link("month", monthly.id, "team", 1)).code).toBe(
        "plan_changed",
      );
      expect(await t.priceRows()).toEqual([]);
    });

    // #439-T05 (review of #468, B1)
    itPg(
      "refuses to link when another admin saves new terms between the check and the write, and rolls everything back",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        let versionReads = 0;
        t.onStatement(async (query) => {
          if (
            query.kind !== "select" ||
            query.table !== "billing_plan_versions"
          )
            return;
          versionReads += 1;
          // The first read is the service's own before it asks Paddle, the second is the check inside the link transaction.
          if (versionReads !== 2) return;
          t.onStatement(undefined);
          const saved = await t.plans.saveTerms(t.admin, "team", {
            basedOnVersion: 1,
            terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: 60 } }),
          });
          expect(saved.ok, "admin B saved new terms").toBe(true);
        });

        const result = await t.link("month", monthly.id);

        expect(refused(result).code).toBe("plan_changed");
        const versions = (await t.view()).versions;
        expect(versions.map((version) => version.number)).toEqual([2, 1]);
        expect(versions.map((version) => version.monthlyPrice)).toEqual([
          null,
          null,
        ]);
        expect(await t.priceRows(), "no price row stays").toEqual([]);
        expect((await t.view()).paddleProductId).toBeNull();
      },
    );

    // #439-T16 (review of #468, N1): relinking is allowed, clearing a link is not.
    it_(
      "never clears a link: a request without a price id answers a stable code and the link stays",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        expect(await t.link("month", monthly.id)).toEqual({ ok: true });

        const result = await t.prices.link(t.admin, "team", {
          versionNumber: 1,
          interval: "month",
          paddlePriceId: null,
        });

        expect(refused(result).code).toBe("price_link_not_clearable");
        expect((await t.current()).monthlyPrice?.paddlePriceId).toBe(
          monthly.id,
        );
      },
    );

    // #439-T16 (review of #468, N1)
    it_(
      "lets the admin who writes first win when two relink the same slot at once, and tells the other",
      async () => {
        const t = await start();
        const first = await t.makePrice();
        const second = await t.makePrice({ description: "Monthly B" });
        const third = await t.makePrice({ description: "Monthly C" });
        expect(await t.link("month", first.id)).toEqual({ ok: true });
        // Both admins saw `first` linked. Admin 2 has read their price when admin 1 relinks the slot to `second`.
        let other: PricesResult | undefined;
        t.afterPriceRead(async () => {
          t.afterPriceRead(undefined);
          other = await t.link("month", second.id);
        });

        const result = await t.link("month", third.id);

        expect(other).toEqual({ ok: true });
        expect(refused(result).code).toBe("price_link_changed");
        expect((await t.current()).monthlyPrice?.paddlePriceId).toBe(second.id);
        expect(
          (await t.priceRows()).map((row) => row.paddle_price_id).sort(),
          "the price admin 2 asked for is not stored: its write was undone",
        ).toEqual([first.id, second.id].sort());
      },
    );

    // #439-T05 (review of #468, N6)
    it_(
      "lets two admins who link the same new price at once both succeed, with one row for the price",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();

        const results = await Promise.all([
          t.link("month", monthly.id, "team", 1),
          t.link("month", monthly.id, "team", 1),
        ]);

        expect(results).toEqual([{ ok: true }, { ok: true }]);
        expect(await t.priceRows()).toHaveLength(1);
        expect((await t.current()).monthlyPrice?.paddlePriceId).toBe(
          monthly.id,
        );
      },
    );

    // #439-T05 (review of #468, N6): the second admin reads the price and the first has linked it before the second writes
    it_(
      "takes the row the other admin made when a price was linked in the meantime, and links to it",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        let other: PricesResult | undefined;
        t.afterPriceRead(async () => {
          t.afterPriceRead(undefined);
          other = await t.link("month", monthly.id);
        });

        const result = await t.link("month", monthly.id);

        expect(other).toEqual({ ok: true });
        expect(result).toEqual({ ok: true });
        expect(await t.priceRows()).toHaveLength(1);
      },
    );

    // #439-T05 (review of #468, N6): the unique index lets one insert through; the loser tries again with a refresh
    itPg(
      "tries again as a refresh when another request stored the same price between the check and the insert",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const planRow = await t.db
          .selectFrom("billing_plans")
          .select("id")
          .where("plan_key", "=", "team")
          .executeTakeFirstOrThrow();
        let priceReads = 0;
        t.onStatement(async (query) => {
          if (query.kind !== "select" || query.table !== "billing_plan_prices")
            return;
          priceReads += 1;
          // The first read is the check before Paddle is asked, the second the one inside the link transaction.
          if (priceReads !== 2) return;
          t.onStatement(undefined);
          const paddle = await t.paddle.getPrice(monthly.id);
          await createBillingPlanPricesRepository(t.db).insertLinked({
            planId: planRow.id,
            paddlePriceId: monthly.id,
            env: "sandbox",
            snapshot: snapshotOf(paddle),
          });
        });

        const result = await t.link("month", monthly.id);

        expect(result).toEqual({ ok: true });
        const rows = await t.priceRows();
        expect(rows, "one row, not two").toHaveLength(1);
        expect((await t.current()).monthlyPrice?.paddlePriceId).toBe(
          monthly.id,
        );
        expect((await t.current()).sellable).toBe(false);
      },
    );

    // #439-T06
    it_("refuses a price that is linked to another plan", async () => {
      const t = await start();
      await t.plans.createPlan(t.admin, plan("pro", { sort: 30 }));
      const shared = await t.makePrice();
      expect(await t.link("month", shared.id, "team")).toEqual({ ok: true });

      const result = refused(await t.link("month", shared.id, "pro"));

      expect(result.code).toBe("price_used_by_other_plan");
      expect((await t.view("pro")).paddleProductId).toBeNull();
      expect((await t.current("pro")).monthlyPrice).toBeNull();
      expect(await t.priceRows()).toHaveLength(1);
    });

    // #439-T09
    it_(
      "stores nothing when Paddle cannot be reached, and says so with a stable code",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        await t.fake.close();

        const result = refused(await t.link("month", monthly.id));

        expect(result.code).toBe("paddle_unreachable");
        expect(await t.priceRows()).toEqual([]);
        expect((await t.view()).paddleProductId).toBeNull();
        expect((await t.current()).monthlyPrice).toBeNull();
      },
    );

    // #439-T04 (review of #468, N7)
    it_(
      "goes on with the other prices when Paddle fails for one, and reports which price failed",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const yearly = await t.yearlyPrice();
        await t.link("month", monthly.id);
        await t.link("year", yearly.id);
        const before = (await t.priceRows()).find(
          (row) => row.paddle_price_id === monthly.id,
        );
        await t.editAtPaddle(monthly.id, {
          unit_price: { amount: "1500", currency_code: "USD" },
        });
        await t.editAtPaddle(yearly.id, {
          unit_price: { amount: "15000", currency_code: "USD" },
        });
        // Paddle fails for the monthly price only.
        t.fake.faults.failWith(
          { method: "GET", path: `/prices/${monthly.id}` },
          500,
          {
            times: 1,
          },
        );

        const result = refused(await t.prices.refresh("team"));

        expect(result).toMatchObject({
          code: "paddle_unavailable",
          failures: [{ paddlePriceId: monthly.id, code: "paddle_unavailable" }],
        });
        const rows = await t.priceRows();
        expect(
          rows.find((row) => row.paddle_price_id === yearly.id),
          "the price after the failing one was read",
        ).toMatchObject({ unit_amount_minor: "15000" });
        expect(
          rows.find((row) => row.paddle_price_id === monthly.id),
          "the failing price keeps what it had",
        ).toEqual(before);
        // The next refresh finds Paddle well again and reports nothing.
        expect(await t.prices.refresh("team")).toEqual({ ok: true });
        expect((await t.current()).monthlyPrice?.amount).toBe("1500");
      },
    );

    // #439-T04 (review of #468, N7)
    it_(
      "names every price that failed, and stops at a refused key because every other read would fail the same",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const yearly = await t.yearlyPrice();
        await t.link("month", monthly.id);
        await t.link("year", yearly.id);

        t.fake.faults.failWith({ method: "GET", path: /^\/prices\// }, 500, {
          times: 2,
        });
        const both = refused(await t.prices.refresh("team"));
        // Rows saved in the same instant come in the order of their ids: compare as sets.
        expect(
          both.failures?.map((failure) => failure.paddlePriceId).sort(),
        ).toEqual([monthly.id, yearly.id].sort());

        const reads = t.fake.requests().length;
        t.fake.faults.failWith({ method: "GET", path: /^\/prices\// }, 403, {
          times: 5,
        });
        const rejected = refused(await t.prices.refresh("team"));
        expect(rejected.code).toBe("paddle_key_rejected");
        expect(rejected.failures).toHaveLength(1);
        expect(
          t.fake.requests().length - reads,
          "one read, then it stopped",
        ).toBe(1);
      },
    );

    // #439-T09
    it_(
      "answers a rate limit, a refused key and a failing Paddle with their own codes and stores nothing",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();

        t.fake.faults.failWith({ method: "GET", path: /^\/prices\// }, 403, {
          times: 1,
        });
        expect(refused(await t.link("month", monthly.id)).code).toBe(
          "paddle_key_rejected",
        );
        t.fake.faults.failWith({ method: "GET", path: /^\/prices\// }, 500, {
          times: 1,
        });
        expect(refused(await t.link("month", monthly.id)).code).toBe(
          "paddle_unavailable",
        );

        expect(await t.priceRows()).toEqual([]);
      },
    );

    it_("refuses when no API key is stored", async () => {
      const t = await start();
      const monthly = await t.makePrice();
      await t.secrets.remove("paddle_api_key");

      expect(refused(await t.link("month", monthly.id)).code).toBe(
        "api_key_missing",
      );
    });

    // #439-T11
    it_(
      "refuses a monthly price and a yearly price whose amount differs from the entered one, with both amounts, and stores nothing",
      async () => {
        const t = await start();
        const monthly = await t.makePrice({
          unit_price: { amount: "1235", currency_code: "USD" },
        });
        const yearly = await t.yearlyPrice({
          unit_price: { amount: "12000", currency_code: "USD" },
        });

        expect(refused(await t.link("month", monthly.id))).toMatchObject({
          code: "price_amount_mismatch",
          entered: "1234",
          paddle: "1235",
        });
        expect(refused(await t.link("year", yearly.id))).toMatchObject({
          code: "price_amount_mismatch",
          entered: "12340",
          paddle: "12000",
        });
        expect(await t.priceRows()).toEqual([]);
        expect((await t.view()).paddleProductId).toBeNull();
      },
    );

    // #439-T12
    it_(
      "refuses a yearly price in the monthly slot and a monthly price in the yearly slot",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const yearly = await t.yearlyPrice();

        expect(refused(await t.link("month", yearly.id)).code).toBe(
          "price_interval_mismatch",
        );
        expect(refused(await t.link("year", monthly.id))).toMatchObject({
          code: "price_interval_mismatch",
          entered: "year",
          paddle: "month",
        });
        expect(await t.priceRows()).toEqual([]);
      },
    );

    // #439-T13
    it_("refuses a price in EUR even with the right amount", async () => {
      const t = await start();
      const euro = await t.makePrice({
        unit_price: { amount: "1234", currency_code: "EUR" },
      });

      expect(refused(await t.link("month", euro.id))).toMatchObject({
        code: "price_currency_mismatch",
        entered: "USD",
        paddle: "EUR",
      });
    });

    // #439-T13 (review of #468, N5)
    it_(
      "treats a currency that is not three capital letters as a mismatch with a placeholder and stores nothing",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        t.rewriteAnswer((price) => ({
          ...price,
          unit_price: {
            ...price.unit_price,
            currency_code: "<img src=x onerror=alert(1)>",
          },
        }));

        const result = refused(await t.link("month", monthly.id));

        expect(result).toMatchObject({
          code: "price_currency_mismatch",
          entered: "USD",
          paddle: "???",
        });
        expect(JSON.stringify(result)).not.toContain("onerror");
        expect(await t.priceRows()).toEqual([]);
      },
    );

    // #439-T13 (review of #468, N5)
    it_(
      "caches the placeholder, not the text, when a linked price comes back with such a currency",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        expect(await t.link("month", monthly.id)).toEqual({ ok: true });
        t.rewriteAnswer((price) => ({
          ...price,
          unit_price: { ...price.unit_price, currency_code: "usd; drop table" },
        }));

        expect(await t.prices.refresh("team")).toEqual({ ok: true });

        expect((await t.priceRows()).map((row) => row.currency)).toEqual([
          "???",
        ]);
        expect((await t.current()).monthlyPrice).toMatchObject({
          currency: "???",
          drift: "price_currency_mismatch",
          driftPaddle: "???",
        });
      },
    );

    // #439-T14
    it_(
      "refuses tax mode external and account_setting even with the right amount",
      async () => {
        const t = await start();
        const external = await t.makePrice({ tax_mode: "external" });
        const account = await t.makePrice({ tax_mode: "account_setting" });

        expect(refused(await t.link("month", external.id))).toMatchObject({
          code: "price_tax_mode_mismatch",
          paddle: "external",
        });
        expect(refused(await t.link("month", account.id))).toMatchObject({
          code: "price_tax_mode_mismatch",
          paddle: "account_setting",
        });
      },
    );

    // #439-T15
    it_(
      "reports one code in the fixed order when a price is wrong in several ways",
      async () => {
        const t = await start();
        const wrong = await t.makePrice({
          unit_price: { amount: "1", currency_code: "EUR" },
          tax_mode: "external",
        });

        expect(refused(await t.link("month", wrong.id)).code).toBe(
          "price_currency_mismatch",
        );
        expect(refused(await t.link("year", wrong.id)).code).toBe(
          "price_interval_mismatch",
        );
        const wrongTax = await t.makePrice({
          unit_price: { amount: "1", currency_code: "USD" },
          tax_mode: "external",
        });
        expect(refused(await t.link("month", wrongTax.id)).code).toBe(
          "price_tax_mode_mismatch",
        );
      },
    );

    // #439-T07
    it_(
      "takes no amount, currency, tax mode or other field from the request, and writes nothing to Paddle",
      async () => {
        const t = await start();
        const monthly = await t.makePrice();
        const before = t.fake.requests().length;

        for (const extra of [
          { amount: 1 },
          { monthlyAmountMinor: 5 },
          { currency: "EUR" },
          { taxMode: "external" },
          { unitPrice: { amount: "1" } },
        ])
          expect(
            refused(
              await t.prices.link(t.admin, "team", {
                versionNumber: 1,
                interval: "month",
                paddlePriceId: monthly.id,
                ...extra,
              }),
            ).code,
            JSON.stringify(extra),
          ).toBe("price_input_invalid");

        expect(t.fake.requests().length).toBe(before);
        expect(await t.link("month", monthly.id)).toEqual({ ok: true });
        expect(t.writesToPaddle(before)).toEqual([]);
      },
    );

    it_(
      "refuses input that is not a price id, a slot or a version number, and a plan that is not paid",
      async () => {
        const t = await start();
        await t.plans.createPlan(t.admin, {
          planKey: "enterprise",
          kind: "contact",
          name: "Enterprise",
          description: "",
          sort: 90,
          offered: true,
          popular: false,
          contactTarget: "https://example.test/contact",
        });
        const monthly = await t.makePrice();

        for (const input of [
          null,
          "month",
          { versionNumber: 1, interval: "week", paddlePriceId: monthly.id },
          { versionNumber: 1, interval: "month", paddlePriceId: "../prices" },
          { versionNumber: 1, interval: "month", paddlePriceId: "pro_01fake1" },
          { versionNumber: "1", interval: "month", paddlePriceId: monthly.id },
          { interval: "month", paddlePriceId: monthly.id },
        ])
          expect(
            refused(await t.prices.link(t.admin, "team", input)).code,
            JSON.stringify(input),
          ).toMatch(/^price_(input|id)_invalid$/);
        expect(
          refused(
            await t.prices.link(t.admin, "enterprise", {
              versionNumber: 1,
              interval: "month",
              paddlePriceId: monthly.id,
            }),
          ).code,
        ).toBe("price_plan_not_paid");
        expect(
          refused(
            await t.prices.link(t.admin, "nope", {
              versionNumber: 1,
              interval: "month",
              paddlePriceId: monthly.id,
            }),
          ).code,
        ).toBe("plan_not_found");
      },
    );
  },
);
