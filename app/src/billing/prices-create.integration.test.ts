// SPDX-License-Identifier: Apache-2.0

// Creating the Paddle prices of a plan version (#440, epic #421) over a real database and the fake Paddle: the version holds
// the amounts the operator entered, the app creates the Paddle product on first use and a new price for each amount (never
// an edit of a price), writes an intent row before it asks Paddle, finds the price again after a lost answer, and links what
// it created through the same compare-and-set as a price the operator links (#439). All numbers are made up.
import type { Kysely, KyselyPlugin, UnknownRow } from "kysely";
import { describe, expect, it } from "vitest";
import type { PlanVersionView } from "../admin/ui/plans-view.ts";
import { createBillingPlanPricesRepository } from "../db/repositories/billing-plan-prices-repository.ts";
import type { Database } from "../db/schema.ts";
import { createSecretStore } from "../secrets/store.ts";
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
import {
  intentIdOf,
  productIntentOf,
  trialDaysToCreate,
} from "./price-create-rules.ts";
import {
  createBillingPricesService,
  type PricesResult,
} from "./prices-service.ts";

const T0 = new Date("2026-10-18T10:00:00.000Z");
const APP_SECRET = "prices-create-test-secret-0123456789-012345";
/** More than the time a request can take: an attempt this old is abandoned. */
const TWENTY_MINUTES = 20 * 60_000;

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
    name: "Team plan",
    description: "",
    sort: 20,
    offered: true,
    popular: false,
    contactTarget: null,
    terms: terms(),
    ...overrides,
  };
}

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

/** Changes what the service reads of one table, as damaged data would: the stored value of a column. */
function rewriteColumn(
  column: string,
  value: unknown,
  active: () => boolean,
): KyselyPlugin {
  return {
    transformQuery: (args) => args.node,
    transformResult: async (args) => ({
      ...args.result,
      rows: active()
        ? args.result.rows.map((row: UnknownRow) =>
            column in row ? { ...row, [column]: value } : row,
          )
        : args.result.rows,
    }),
  };
}

async function startOn(open: () => Promise<Kysely<Database>>) {
  const db = await open();
  let clock = T0;
  let damaged = false;
  const serviceDb = db.withPlugin(
    rewriteColumn("monthly_amount_minor", 0, () => damaged),
  );
  const admin = await insertUser(db, { id: "admin-1", isInstanceAdmin: true });
  await setBillingSwitch(db, true);
  const fake = await startTestPaddle();
  const secrets = createSecretStore({ db, appSecret: APP_SECRET });
  await secrets.save("paddle_api_key", fake.apiKey, { updatedBy: admin });
  const plans = createBillingPlansService({ db, now: () => clock });
  // Runs once Paddle has created a price and before the service goes on: the moment something else can happen.
  let afterCreate: ((price: PaddlePrice) => Promise<void>) | undefined;
  const prices = createBillingPricesService({
    db: serviceDb,
    secrets,
    now: () => clock,
    // A short limit, so a dropped answer is a timeout the test can wait for.
    clientFor: () => {
      const real = clientFor(fake, { timeoutMs: 250 });
      const client: PaddleClient = {
        ...real,
        createPrice: async (input) => {
          const price = await real.createPrice(input);
          await afterCreate?.(price);
          return price;
        },
      };
      return client;
    },
  });
  const paddle = clientFor(fake);
  expect(
    (await plans.createPlan(admin, plan("team"))).ok,
    "the plan is created",
  ).toBe(true);

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
  const create = async (
    extra: Record<string, unknown> = {},
    planKey = "team",
  ): Promise<PricesResult> =>
    prices.create(admin, planKey, {
      versionNumber: (await current(planKey)).number,
      ...extra,
    });
  const versionId = async (number: number, planKey = "team") =>
    (
      await db
        .selectFrom("billing_plan_versions")
        .innerJoin(
          "billing_plans",
          "billing_plans.id",
          "billing_plan_versions.plan_id",
        )
        .select("billing_plan_versions.id")
        .where("billing_plans.plan_key", "=", planKey)
        .where("billing_plan_versions.number", "=", number)
        .executeTakeFirstOrThrow()
    ).id;
  const posts = (path: string) =>
    fake
      .requests()
      .filter((request) => request.method === "POST" && request.path === path);
  const paddlePrices = () => fake.prices();
  const rows = () =>
    db
      .selectFrom("billing_plan_prices")
      .selectAll()
      .orderBy("interval", "asc")
      .execute();
  const repository = () => createBillingPlanPricesRepository(db, () => clock);
  const planId = async () =>
    (
      await db
        .selectFrom("billing_plans")
        .select("id")
        .where("plan_key", "=", "team")
        .executeTakeFirstOrThrow()
    ).id;

  return {
    db,
    admin,
    fake,
    secrets,
    plans,
    prices,
    paddle,
    view,
    current,
    create,
    versionId,
    posts,
    paddlePrices,
    rows,
    repository,
    planId,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    afterCreate: (hook: typeof afterCreate) => {
      afterCreate = hook;
    },
    /** From now on the service reads a monthly amount of zero from the database, as a damaged row would give it. */
    damageMonthlyAmount: () => {
      damaged = true;
    },
  };
}

function refused(result: PricesResult) {
  if (result.ok) throw new Error("expected a refusal");
  return result;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition(), "the condition came true in time").toBe(true);
}

describe.each(ENGINES)(
  "creating the Paddle prices of a plan version on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;
    const start = () => startOn(engine.open);

    // #440-T01
    it_(
      "creates the product and a monthly and a yearly price with the entered amounts, links them and makes the version sellable",
      async () => {
        const t = await start();

        expect(await t.create()).toEqual({ ok: true });

        expect(t.fake.products()).toHaveLength(1);
        const [monthly, yearly] = t.paddlePrices();
        expect(monthly).toMatchObject({
          unit_price: { amount: "1234", currency_code: "USD" },
          billing_cycle: { interval: "month", frequency: 1 },
          tax_mode: "internal",
          status: "active",
          type: "standard",
          quantity: { minimum: 1, maximum: 1 },
          product_id: t.fake.products()[0]?.id,
        });
        expect(yearly).toMatchObject({
          unit_price: { amount: "12340", currency_code: "USD" },
          billing_cycle: { interval: "year", frequency: 1 },
          tax_mode: "internal",
        });
        const rows = await t.rows();
        expect(rows).toHaveLength(2);
        expect(
          rows.map((row) => [row.interval, row.state, row.origin]),
        ).toEqual([
          ["month", "ready", "created"],
          ["year", "ready", "created"],
        ]);
        const version = await t.current();
        expect(version.monthlyPrice).toMatchObject({
          paddlePriceId: monthly?.id,
          amount: "1234",
          drift: null,
        });
        expect(version.yearlyPrice).toMatchObject({
          paddlePriceId: yearly?.id,
          amount: "12340",
          drift: null,
        });
        expect(version.sellable).toBe(true);
        expect((await t.view()).paddleProductId).toBe(t.fake.products()[0]?.id);
      },
    );

    // #440-T12
    it_(
      "sends exactly the entered amounts, USD, tax inclusive, one month and one year, a quantity of one and no override",
      async () => {
        const t = await start();
        const versionId = await t.versionId(1);
        const planId = await t.planId();

        await t.create();

        expect(t.posts("/products").map((request) => request.body)).toEqual([
          {
            name: "Team plan",
            tax_category: "saas",
            type: "standard",
            custom_data: {
              cr_plan_key: "team",
              cr_intent: productIntentOf(planId),
            },
          },
        ]);
        const productId = t.fake.products()[0]?.id;
        expect(t.posts("/prices").map((request) => request.body)).toEqual([
          {
            product_id: productId,
            type: "standard",
            description: "Monthly price of the plan team",
            unit_price: { amount: "1234", currency_code: "USD" },
            billing_cycle: { interval: "month", frequency: 1 },
            tax_mode: "internal",
            quantity: { minimum: 1, maximum: 1 },
            custom_data: {
              cr_plan_key: "team",
              cr_intent: intentIdOf({
                versionId,
                interval: "month",
                trialDays: null,
              }),
            },
          },
          {
            product_id: productId,
            type: "standard",
            description: "Yearly price of the plan team",
            unit_price: { amount: "12340", currency_code: "USD" },
            billing_cycle: { interval: "year", frequency: 1 },
            tax_mode: "internal",
            quantity: { minimum: 1, maximum: 1 },
            custom_data: {
              cr_plan_key: "team",
              cr_intent: intentIdOf({
                versionId,
                interval: "year",
                trialDays: null,
              }),
            },
          },
        ]);
        for (const request of t.posts("/prices"))
          expect(JSON.stringify(request.body)).not.toContain("overrides");
      },
    );

    // #440-T11
    it_(
      "creates only the monthly price of a version that has no yearly price, and offers no yearly option",
      async () => {
        const t = await start();
        await t.plans.saveTerms(t.admin, "team", {
          basedOnVersion: 1,
          terms: terms({ yearlyAmountMinor: null }),
        });

        expect(await t.create()).toEqual({ ok: true });

        expect(t.paddlePrices()).toHaveLength(1);
        expect(t.paddlePrices()[0]?.billing_cycle).toEqual({
          interval: "month",
          frequency: 1,
        });
        expect((await t.rows()).map((row) => row.interval)).toEqual(["month"]);
        const version = await t.current();
        expect(version.yearlyPrice).toBeNull();
        expect(version.yearlyAmountMinor).toBeNull();
        expect(version.sellable).toBe(true);
      },
    );

    // #440-T06
    it_(
      "puts the trial days on the prices it creates, and none by default",
      async () => {
        const withTrial = await start();
        expect(await withTrial.create({ trialDays: 14 })).toEqual({ ok: true });
        for (const price of withTrial.paddlePrices())
          expect(price.trial_period).toMatchObject({
            interval: "day",
            frequency: 14,
          });
        expect((await withTrial.rows()).map((row) => row.trial_days)).toEqual([
          14, 14,
        ]);
        expect((await withTrial.current()).monthlyPrice?.trialDays).toBe(14);

        const without = await start();
        await without.create();
        for (const price of without.paddlePrices())
          expect(price.trial_period ?? null).toBeNull();
        expect((await without.rows()).map((row) => row.trial_days)).toEqual([
          null,
          null,
        ]);
      },
    );

    // #440-T06
    it_(
      "refuses trial days that are not whole days from 1 to a year before it asks Paddle",
      async () => {
        const t = await start();

        for (const trialDays of [0, -3, 1.5, 366, "14", true]) {
          expect(
            refused(await t.create({ trialDays })),
            String(trialDays),
          ).toEqual({
            ok: false,
            code: "price_trial_invalid",
            field: "trialDays",
          });
        }

        expect(t.fake.requests()).toEqual([]);
        expect(trialDaysToCreate(14)).toEqual({ ok: true, days: 14 });
      },
    );

    // #440-T05
    it_(
      "refuses a stored amount that is not a positive whole number of minor units before it asks Paddle",
      async () => {
        const t = await start();
        t.damageMonthlyAmount();

        expect(refused(await t.create())).toMatchObject({
          code: "price_amount_invalid",
          field: "month",
        });

        expect(t.fake.requests()).toEqual([]);
        expect(await t.rows()).toEqual([]);
      },
    );

    // #440-T13
    it_(
      "takes nothing but the version number and the trial days from the request: no amount, currency, interval or tax mode",
      async () => {
        const t = await start();

        for (const extra of [
          { amount: 1 },
          { amountMinor: 1 },
          { monthlyAmountMinor: 1 },
          { currency: "EUR" },
          { currency_code: "EUR" },
          { interval: "year" },
          { taxMode: "external" },
          { tax_mode: "external" },
          { unitPrice: { amount: "1", currency_code: "EUR" } },
          { productId: "pro_01fake00000000000000000001" },
        ])
          expect(refused(await t.create(extra)), JSON.stringify(extra)).toEqual(
            {
              ok: false,
              code: "price_input_invalid",
            },
          );
        expect(
          refused(await t.prices.create(t.admin, "team", [])),
        ).toMatchObject({ code: "price_input_invalid" });
        expect(
          refused(
            await t.prices.create(t.admin, "team", { versionNumber: "1" }),
          ),
        ).toMatchObject({ code: "price_input_invalid" });

        expect(t.fake.requests()).toEqual([]);
        expect(await t.rows()).toEqual([]);
      },
    );

    // #440-T02
    it_(
      "finds the price again after a lost answer, links it, and leaves exactly one price per interval",
      async () => {
        const t = await start();
        t.fake.faults.dropResponse(
          { method: "POST", path: "/prices" },
          { times: 1 },
        );

        expect(await t.create()).toEqual({ ok: true });

        expect(t.paddlePrices()).toHaveLength(2);
        expect(
          t.paddlePrices().map((price) => price.billing_cycle?.interval),
        ).toEqual(["month", "year"]);
        const rows = await t.rows();
        expect(rows.map((row) => row.state)).toEqual(["ready", "ready"]);
        expect(rows.map((row) => row.paddle_price_id)).toEqual(
          t.paddlePrices().map((price) => price.id),
        );
        // The lost create was not repeated: it was looked up.
        expect(t.posts("/prices")).toHaveLength(2);
        expect((await t.current()).sellable).toBe(true);
      },
    );

    // #440-T02
    it_(
      "finds the price again when the connection is reset after the create",
      async () => {
        const t = await start();
        t.fake.faults.dropResponse(
          { method: "POST", path: "/prices" },
          { times: 1, mode: "reset" },
        );

        expect(await t.create()).toEqual({ ok: true });

        expect(t.paddlePrices()).toHaveLength(2);
      },
    );

    // #440-T03
    it_(
      "retries a server error and a rate limit a bounded number of times and creates one price",
      async () => {
        const t = await start();
        t.fake.faults.failWith({ method: "POST", path: "/prices" }, 500, {
          times: 1,
        });
        t.fake.faults.rateLimit(
          { method: "POST", path: "/prices" },
          { retryAfterSeconds: 1, times: 1 },
        );

        expect(await t.create()).toEqual({ ok: true });

        expect(t.paddlePrices()).toHaveLength(2);
        // The monthly create: refused (500), limited (429), made. The yearly one: made.
        expect(t.posts("/prices")).toHaveLength(4);
      },
    );

    // #440-T03
    it_(
      "gives up after a few tries when Paddle keeps failing, with a failed row and no Paddle price, and a later request goes on",
      async () => {
        const t = await start();
        t.fake.faults.failWith({ method: "POST", path: "/prices" }, 500, {
          times: 100,
        });

        expect(refused(await t.create())).toMatchObject({
          code: "paddle_unavailable",
          field: "month",
        });

        expect(t.posts("/prices").length).toBeLessThanOrEqual(3);
        expect(t.paddlePrices()).toHaveLength(0);
        expect(await t.rows()).toMatchObject([
          {
            interval: "month",
            state: "failed",
            last_error_code: "paddle_unavailable",
            paddle_price_id: null,
          },
        ]);

        t.fake.faults.clear();
        expect(await t.create()).toEqual({ ok: true });
        expect(t.paddlePrices()).toHaveLength(2);
        expect(await t.rows()).toHaveLength(2);
      },
    );

    // #440-T04
    it_(
      "leaves a failed row with a stable code after a permanent Paddle error, and a retry reuses the row",
      async () => {
        const t = await start();
        t.fake.faults.failWith({ method: "POST", path: "/prices" }, 400, {
          times: 1,
          body: {
            error: {
              type: "request_error",
              code: "invalid_field",
              detail: "PADDLE-DETAIL-THAT-MUST-NOT-LEAK",
            },
          },
        });

        const result = refused(await t.create());

        expect(result).toEqual({
          ok: false,
          code: "price_create_rejected",
          field: "month",
        });
        expect(JSON.stringify(result)).not.toContain("PADDLE-DETAIL");
        const [failed] = await t.rows();
        expect(failed).toMatchObject({
          state: "failed",
          last_error_code: "price_create_rejected",
          paddle_price_id: null,
        });

        expect(await t.create()).toEqual({ ok: true });

        const rows = await t.rows();
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.interval === "month")).toMatchObject({
          id: failed?.id,
          state: "ready",
          last_error_code: null,
        });
        expect(t.paddlePrices()).toHaveLength(2);
      },
    );

    // #440-T04
    it_(
      "answers a refused key and an unreachable Paddle with their own codes and, once a price row exists, a failed row",
      async () => {
        const t = await start();
        t.fake.faults.failWith({ method: "POST", path: "/prices" }, 403, {
          times: 1,
        });
        expect(refused(await t.create())).toMatchObject({
          code: "paddle_key_rejected",
        });
        expect((await t.rows())[0]).toMatchObject({
          state: "failed",
          last_error_code: "paddle_key_rejected",
        });
      },
    );

    // #440-T04
    it_(
      "answers a Paddle that keeps failing at the product with its own code after a bounded number of tries and stores no price row",
      async () => {
        const t = await start();
        t.fake.faults.failWith({ method: "POST", path: "/products" }, 503, {
          times: 10,
        });

        expect(refused(await t.create())).toMatchObject({
          code: "paddle_unavailable",
        });

        expect(t.posts("/products").length).toBeLessThanOrEqual(3);
        expect(t.fake.products()).toEqual([]);
        expect(await t.rows()).toEqual([]);
        expect((await t.view()).paddleProductId).toBeNull();
      },
    );

    // #440-T14
    it_(
      "keeps the monthly price when the yearly create fails, and a retry creates only the yearly one",
      async () => {
        const t = await start();
        t.afterCreate(async (price) => {
          if (price.billing_cycle?.interval !== "month") return;
          t.fake.faults.failWith({ method: "POST", path: "/prices" }, 400, {
            times: 1,
          });
        });

        expect(refused(await t.create())).toMatchObject({
          code: "price_create_rejected",
          field: "year",
        });

        const monthlyId = t.paddlePrices()[0]?.id;
        expect(t.paddlePrices()).toHaveLength(1);
        expect(await t.rows()).toMatchObject([
          { interval: "month", state: "ready", paddle_price_id: monthlyId },
          { interval: "year", state: "failed", paddle_price_id: null },
        ]);
        const half = await t.current();
        expect(half.monthlyPrice?.paddlePriceId).toBe(monthlyId);
        expect(half.yearlyPrice).toBeNull();
        expect(half.sellable).toBe(false);

        const before = t.posts("/prices").length;
        expect(await t.create()).toEqual({ ok: true });

        expect(t.posts("/prices").length - before).toBe(1);
        expect(t.paddlePrices()).toHaveLength(2);
        expect(t.paddlePrices()[0]?.id).toBe(monthlyId);
        expect((await t.current()).sellable).toBe(true);
      },
    );

    // #440-T14
    it_(
      "finds the yearly price by its intent when the answer to its create is lost, in the same request",
      async () => {
        const t = await start();
        t.afterCreate(async (price) => {
          if (price.billing_cycle?.interval !== "month") return;
          t.fake.faults.dropResponse(
            { method: "POST", path: "/prices" },
            { times: 1 },
          );
        });

        expect(await t.create()).toEqual({ ok: true });

        expect(t.paddlePrices()).toHaveLength(2);
        expect(t.posts("/prices")).toHaveLength(2);
        expect((await t.current()).sellable).toBe(true);
      },
    );

    // #440-T09
    it_(
      "lets one of two admins who create at once do the work: the other is told it is being done, and no price is made twice",
      async () => {
        const t = await start();
        t.fake.faults.delay({ method: "POST", path: "/prices" }, 300, {
          times: 2,
        });
        const first = t.create();
        await waitFor(() => t.posts("/prices").length >= 1);

        const second = refused(await t.create());
        const firstResult = await first;

        expect(second).toMatchObject({
          code: "price_creation_pending",
          field: "month",
        });
        expect(firstResult).toEqual({ ok: true });
        expect(t.paddlePrices()).toHaveLength(2);
        expect(await t.rows()).toHaveLength(2);
        // A click after the work is done changes nothing.
        expect(await t.create()).toEqual({ ok: true });
        expect(t.paddlePrices()).toHaveLength(2);
        expect(t.fake.products()).toHaveLength(1);
      },
    );

    // #440-T09
    it_(
      "does nothing on a second click: the slots are linked, no call is made",
      async () => {
        const t = await start();
        await t.create();
        const before = t.fake.requests().length;

        expect(await t.create()).toEqual({ ok: true });

        expect(t.fake.requests().length).toBe(before);
        expect(await t.rows()).toHaveLength(2);
      },
    );

    // #440-T24
    it_(
      "takes over an attempt that died, after it has looked at Paddle: the price it made is adopted, not made again",
      async () => {
        const t = await start();
        const repository = t.repository();
        const planId = await t.planId();
        const versionId = await t.versionId(1);
        // The first attempt: the product exists, the row is pending, the create ran at Paddle and the process died.
        const product = await t.paddle.createProduct({
          name: "Team plan",
          tax_category: "saas",
          custom_data: {
            cr_plan_key: "team",
            cr_intent: productIntentOf(planId),
          },
        });
        const intent = intentIdOf({
          versionId,
          interval: "month",
          trialDays: null,
        });
        await repository.insertPending({
          planId,
          intentId: intent,
          env: "sandbox",
          productId: product.id,
          interval: "month",
          amount: "1234",
          currency: "USD",
          taxMode: "internal",
          quantityMinimum: 1,
          quantityMaximum: 1,
          trialDays: null,
        });
        const made = await t.paddle.createPrice({
          product_id: product.id,
          type: "standard",
          description: "Monthly price of the plan team",
          unit_price: { amount: "1234", currency_code: "USD" },
          billing_cycle: { interval: "month", frequency: 1 },
          tax_mode: "internal",
          quantity: { minimum: 1, maximum: 1 },
          custom_data: { cr_plan_key: "team", cr_intent: intent },
        });

        // Fresh: somebody may still be at it.
        expect(refused(await t.create())).toMatchObject({
          code: "price_creation_pending",
          field: "month",
        });
        expect(t.paddlePrices()).toHaveLength(1);

        t.advance(TWENTY_MINUTES);
        expect(await t.create()).toEqual({ ok: true });

        expect(t.paddlePrices().map((price) => price.id)).toContain(made.id);
        expect(t.paddlePrices()).toHaveLength(2);
        expect(t.fake.products()).toHaveLength(1);
        expect((await t.current()).monthlyPrice?.paddlePriceId).toBe(made.id);
      },
    );

    // #440-T28
    it_(
      "finds the product again after a lost answer and binds exactly one product to the plan",
      async () => {
        const t = await start();
        t.fake.faults.dropResponse(
          { method: "POST", path: "/products" },
          { times: 1 },
        );

        expect(await t.create()).toEqual({ ok: true });

        expect(t.fake.products()).toHaveLength(1);
        expect(t.posts("/products")).toHaveLength(1);
        expect((await t.view()).paddleProductId).toBe(t.fake.products()[0]?.id);
        for (const price of t.paddlePrices())
          expect(price.product_id).toBe(t.fake.products()[0]?.id);
      },
    );

    // #440-T28
    it_(
      "adopts the product an earlier attempt made for the plan instead of making another",
      async () => {
        const t = await start();
        const planId = await t.planId();
        const earlier = await t.paddle.createProduct({
          name: "Team plan",
          tax_category: "saas",
          custom_data: {
            cr_plan_key: "team",
            cr_intent: productIntentOf(planId),
          },
        });
        await t.paddle.createProduct({
          name: "Somebody else's",
          tax_category: "saas",
          custom_data: { cr_plan_key: "other" },
        });

        expect(await t.create()).toEqual({ ok: true });

        expect(t.posts("/products")).toHaveLength(2);
        expect((await t.view()).paddleProductId).toBe(earlier.id);
      },
    );

    // #440-T25
    it_(
      "records a price that was created but could not be linked because the plan changed meanwhile: it is not archived, not lost, and shows as an attempt to archive",
      async () => {
        const t = await start();
        t.afterCreate(async (price) => {
          if (price.billing_cycle?.interval !== "month") return;
          expect(
            (
              await t.plans.saveTerms(t.admin, "team", {
                basedOnVersion: 1,
                terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: 60 } }),
              })
            ).ok,
          ).toBe(true);
        });

        expect(refused(await t.create({}, "team"))).toMatchObject({
          code: "plan_changed",
        });

        const created = t.paddlePrices()[0];
        expect(created).toMatchObject({ status: "active" });
        // Nothing is archived or edited at Paddle: only creates and reads were sent.
        expect(
          t.fake.requests().filter((request) => request.method === "PATCH"),
        ).toEqual([]);
        const [row] = await t.rows();
        expect(row).toMatchObject({
          paddle_price_id: created?.id,
          state: "ready",
          origin: "created",
        });
        // No version has it.
        const versions = (await t.view()).versions;
        expect(versions.map((version) => version.monthlyPrice)).toEqual([
          null,
          null,
        ]);
        expect((await t.view()).priceAttempts).toMatchObject([
          {
            interval: "month",
            state: "ready",
            paddlePriceId: created?.id,
            amount: "1234",
          },
        ]);
      },
    );

    // #440-T25
    it_(
      "records the price when another admin linked a different price to the slot between the create and the link",
      async () => {
        const t = await start();
        t.afterCreate(async (price) => {
          if (price.billing_cycle?.interval !== "month") return;
          // Another admin links a price made by hand to the monthly slot.
          const repository = t.repository();
          const planId = await t.planId();
          const byHand = await repository.insertLinked({
            planId,
            paddlePriceId: "pri_01fakebyhand000000000001",
            env: "sandbox",
            snapshot: {
              productId: price.product_id,
              priceType: "standard",
              interval: "month",
              frequency: 1,
              currency: "USD",
              amount: "1234",
              taxMode: "internal",
              hasOverrides: false,
              trialDays: null,
              quantityMinimum: 1,
              quantityMaximum: 1,
              status: "active",
            },
          });
          await t.db
            .updateTable("billing_plan_versions")
            .set({ monthly_price_id: byHand.id })
            .execute();
        });

        expect(refused(await t.create())).toMatchObject({
          code: "price_link_changed",
        });

        const created = t.paddlePrices()[0];
        expect(
          (await t.rows()).find((row) => row.paddle_price_id === created?.id),
        ).toMatchObject({ state: "ready", origin: "created" });
        expect((await t.view()).priceAttempts).toMatchObject([
          { state: "ready", paddlePriceId: created?.id },
        ]);
      },
    );

    // #440-T26
    it_(
      "shows a failed attempt with its code and a pending one in the view, and neither once the price is linked",
      async () => {
        const t = await start();
        t.fake.faults.failWith({ method: "POST", path: "/prices" }, 400, {
          times: 1,
        });
        await t.create();

        expect((await t.view()).priceAttempts).toMatchObject([
          {
            interval: "month",
            state: "failed",
            errorCode: "price_create_rejected",
            paddlePriceId: null,
          },
        ]);

        await t.create();
        expect((await t.view()).priceAttempts).toEqual([]);
      },
    );

    // #440-T08
    it_(
      "refuses to archive a price a live subscription uses and archives one nobody uses, with a status change alone",
      async () => {
        const t = await start();
        await t.create();
        // New terms: the version the prices were made for is legacy now, and the current one has no price.
        await t.plans.saveTerms(t.admin, "team", {
          basedOnVersion: 1,
          terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: 60 } }),
        });
        const [monthly, yearly] = t.paddlePrices();
        if (monthly === undefined || yearly === undefined)
          throw new Error("no price");
        t.fake.seedSubscription({ priceId: monthly.id, status: "past_due" });

        expect(
          refused(
            await t.prices.archive(t.admin, "team", {
              paddlePriceId: monthly.id,
            }),
          ),
        ).toEqual({
          ok: false,
          code: "price_has_subscribers",
          field: "paddlePriceId",
        });
        expect(t.paddlePrices()[0]?.status).toBe("active");

        expect(
          await t.prices.archive(t.admin, "team", { paddlePriceId: yearly.id }),
        ).toEqual({ ok: true });

        expect(t.paddlePrices()[1]?.status).toBe("archived");
        const patches = t.fake
          .requests()
          .filter((request) => request.method === "PATCH");
        expect(patches).toHaveLength(1);
        expect(patches[0]).toMatchObject({
          path: `/prices/${yearly.id}`,
          body: { status: "archived" },
        });
        expect(Object.keys(patches[0]?.body as object)).toEqual(["status"]);
        const row = (await t.rows()).find(
          (candidate) => candidate.paddle_price_id === yearly.id,
        );
        expect(row).toMatchObject({ paddle_status: "archived" });
        expect(row?.archived_at).not.toBeNull();
        // Asking again is no new call.
        expect(
          await t.prices.archive(t.admin, "team", { paddlePriceId: yearly.id }),
        ).toEqual({ ok: true });
        expect(
          t.fake.requests().filter((request) => request.method === "PATCH"),
        ).toHaveLength(1);
      },
    );

    // #440-T08
    it_(
      "refuses to archive the price the current version is sold with, a price of no plan of ours, and a body that is not a price id",
      async () => {
        const t = await start();
        await t.create();
        const [monthly] = t.paddlePrices();
        if (monthly === undefined) throw new Error("no price");

        expect(
          refused(
            await t.prices.archive(t.admin, "team", {
              paddlePriceId: monthly.id,
            }),
          ),
        ).toMatchObject({ code: "price_in_use" });
        expect(
          refused(
            await t.prices.archive(t.admin, "team", {
              paddlePriceId: "pri_01fakeunknown00000000001",
            }),
          ),
        ).toMatchObject({ code: "price_not_found" });
        expect(
          refused(
            await t.prices.archive(t.admin, "team", { paddlePriceId: 5 }),
          ),
        ).toMatchObject({ code: "price_id_invalid" });
        expect(
          refused(
            await t.prices.archive(t.admin, "team", {
              paddlePriceId: monthly.id,
              extra: 1,
            }),
          ),
        ).toMatchObject({ code: "price_input_invalid" });
        expect(
          refused(
            await t.prices.archive(t.admin, "nope", {
              paddlePriceId: monthly.id,
            }),
          ),
        ).toMatchObject({ code: "plan_not_found" });
        expect(
          t.fake.requests().filter((request) => request.method === "PATCH"),
        ).toEqual([]);
      },
    );

    // #440-T27
    it_(
      "archives the orphan a failed link left behind, and the view stops listing it",
      async () => {
        const t = await start();
        t.afterCreate(async (price) => {
          if (price.billing_cycle?.interval !== "month") return;
          await t.plans.saveTerms(t.admin, "team", {
            basedOnVersion: 1,
            terms: terms({ limits: { ...LIMITS, diffRunsPerPeriod: 60 } }),
          });
        });
        await t.create();
        t.afterCreate(undefined);
        const orphan = t.paddlePrices()[0];
        if (orphan === undefined) throw new Error("no orphan");
        expect((await t.view()).priceAttempts).toHaveLength(1);

        expect(
          await t.prices.archive(t.admin, "team", { paddlePriceId: orphan.id }),
        ).toEqual({ ok: true });

        expect(t.paddlePrices()[0]?.status).toBe("archived");
        expect((await t.view()).priceAttempts).toEqual([]);
      },
    );

    // #440-T15
    it_(
      "makes new prices for a changed amount, edits no old price, and leaves the old version legacy with its prices",
      async () => {
        const t = await start();
        await t.create();
        const [oldMonthly, oldYearly] = t
          .paddlePrices()
          .map((price) => price.id);
        await t.plans.saveTerms(t.admin, "team", {
          basedOnVersion: 1,
          terms: terms({ monthlyAmountMinor: 1500, yearlyAmountMinor: 15_000 }),
        });

        expect(await t.create()).toEqual({ ok: true });

        const prices = t.paddlePrices();
        expect(prices).toHaveLength(4);
        expect(prices.slice(2).map((price) => price.unit_price.amount)).toEqual(
          ["1500", "15000"],
        );
        expect(
          t.fake.requests().filter((request) => request.method === "PATCH"),
        ).toEqual([]);
        // The old prices are as they were.
        expect(
          prices.slice(0, 2).map((price) => price.unit_price.amount),
        ).toEqual(["1234", "12340"]);
        const versions = (await t.view()).versions;
        expect(
          versions.map((version) => [version.number, version.role]),
        ).toEqual([
          [2, "current"],
          [1, "legacy"],
        ]);
        expect(versions[1]?.monthlyPrice?.paddlePriceId).toBe(oldMonthly);
        expect(versions[1]?.yearlyPrice?.paddlePriceId).toBe(oldYearly);
        expect(versions[0]?.sellable).toBe(true);
        expect(t.fake.products()).toHaveLength(1);
      },
    );

    // #440-T29
    it_(
      "refuses a plan that is not paid, archived or changed, and a missing key, with a code each and no call to Paddle",
      async () => {
        const t = await start();
        await t.plans.createPlan(t.admin, {
          planKey: "talk",
          kind: "contact",
          name: "Talk",
          description: "",
          sort: 40,
          offered: true,
          popular: false,
          contactTarget: "mailto:sales@example.test",
        });
        expect(
          refused(await t.prices.create(t.admin, "talk", { versionNumber: 1 })),
        ).toMatchObject({ code: "price_plan_not_paid" });
        expect(
          refused(await t.prices.create(t.admin, "nope", { versionNumber: 1 })),
        ).toMatchObject({ code: "plan_not_found" });
        expect(
          refused(await t.prices.create(t.admin, "team", { versionNumber: 7 })),
        ).toMatchObject({ code: "plan_changed" });
        await t.plans.setArchived(t.admin, "team", true);
        expect(refused(await t.create())).toMatchObject({
          code: "plan_archived",
        });
        await t.plans.setArchived(t.admin, "team", false);
        expect(t.fake.requests()).toEqual([]);

        await t.secrets.remove("paddle_api_key");
        expect(refused(await t.create())).toMatchObject({
          code: "api_key_missing",
        });
        expect(t.fake.requests()).toEqual([]);
      },
    );

    // #440-T30
    it_(
      "refuses a plan whose product belongs to the other Paddle environment",
      async () => {
        const t = await start();
        await t.db
          .updateTable("billing_plans")
          .set({
            paddle_product_id: "pro_01fakelive0000000000000001",
            paddle_product_env: "live",
          })
          .execute();

        expect(refused(await t.create())).toMatchObject({
          code: "price_environment_mismatch",
        });
        expect(t.fake.requests()).toEqual([]);
      },
    );
  },
);
