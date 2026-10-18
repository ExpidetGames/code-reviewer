// SPDX-License-Identifier: Apache-2.0

// The link of a Paddle price on the plans routes (#439): for the instance admin only, absent while billing is off, one change
// per request, with no field for an amount, a currency or a tax mode, and every refusal a stable code with the two values of
// a mismatch. The fake Paddle is behind the real prices service; the portal around the routes (proxy, sessions) is tested by
// src/admin, so these tests hand the handlers the access result directly.
import { describe, expect, it } from "vitest";
import type { AdminAccess } from "../admin/access.ts";
import type { PlansView } from "../admin/ui/plans-view.ts";
import { createSecretStore } from "../secrets/store.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { NotFoundSignal } from "../test-support/admin-harness.ts";
import { clientFor, startTestPaddle } from "../test-support/paddle-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { createPlansRouteHandlers } from "./plans-http.ts";
import { createBillingPlansService } from "./plans-service.ts";
import { createBillingPricesService } from "./prices-service.ts";

const LIMITS = {
  diffRunsPerPeriod: 40,
  dynamicRunsPerPeriod: 8,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

const NEW_PLAN = {
  planKey: "team",
  kind: "paid",
  name: "Team",
  description: "",
  sort: 20,
  offered: true,
  popular: false,
  contactTarget: null,
  terms: {
    keyMode: "managed",
    limits: LIMITS,
    modelAccess: { catalogEntries: null },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: null,
  },
};

async function start(
  options: { access?: AdminAccess; billingOn?: boolean } = {},
) {
  const { db } = await createTestDatabase();
  const admin = await insertUser(db, { id: "admin-1", isInstanceAdmin: true });
  await setBillingSwitch(db, true);
  const fake = await startTestPaddle();
  const secrets = createSecretStore({
    db,
    appSecret: "prices-http-test-secret-0123456789-0123456789",
  });
  await secrets.save("paddle_api_key", fake.apiKey, { updatedBy: admin });
  const paddle = clientFor(fake);
  const service = createBillingPlansService({ db });
  let access: AdminAccess =
    options.access ?? ({ kind: "admin", user: { id: admin } } as AdminAccess);
  let reads = 0;
  const prices = createBillingPricesService({
    db,
    secrets,
    clientFor: () => {
      reads += 1;
      return clientFor(fake);
    },
  });
  const handlers = createPlansRouteHandlers({
    access: () => Promise.resolve(access),
    notFound: () => {
      throw new NotFoundSignal();
    },
    isOn: () => Promise.resolve(options.billingOn ?? true),
    service,
    prices,
  });
  const product = await paddle.createProduct({
    name: "Team",
    tax_category: "standard",
  });
  return {
    handlers,
    fake,
    paddle,
    product,
    reads: () => reads,
    setAccess: (next: AdminAccess) => {
      access = next;
    },
    async setUp() {
      const response = await handlers.create(
        json("POST", "/api/admin/billing/plans", NEW_PLAN),
      );
      expect(response.status).toBe(200);
    },
    price: (amount = "1234", overrides: Record<string, unknown> = {}) =>
      paddle.createPrice({
        product_id: product.id,
        description: "Monthly",
        unit_price: { amount, currency_code: "USD" },
        billing_cycle: { interval: "month", frequency: 1 },
        tax_mode: "internal",
        ...overrides,
      }),
  };
}

function json(method: string, path: string, body: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const put = (body: unknown) =>
  json("PUT", "/api/admin/billing/plans/team", body);
const link = (paddlePriceId: string, extra: Record<string, unknown> = {}) =>
  put({
    priceLink: { versionNumber: 1, interval: "month", paddlePriceId, ...extra },
  });

describe("the price routes", () => {
  // #439-T08
  it("answer an anonymous caller 401 and call nobody", async () => {
    const t = await start({ access: { kind: "anonymous" } as AdminAccess });

    const linked = await t.handlers.change(link("pri_01fake1"), "team");
    const refreshed = await t.handlers.change(
      put({ refreshPrices: true }),
      "team",
    );

    expect(linked.status).toBe(401);
    expect(refreshed.status).toBe(401);
    expect(await linked.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(t.reads()).toBe(0);
    expect(
      t.fake.requests().filter((r) => r.path.startsWith("/prices")),
    ).toEqual([]);
  });

  // #439-T08
  it("answer somebody who is not an admin as a path that does not exist", async () => {
    const t = await start({ access: { kind: "not_admin" } as AdminAccess });

    await expect(
      t.handlers.change(link("pri_01fake1"), "team"),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    await expect(
      t.handlers.change(put({ refreshPrices: true }), "team"),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    expect(t.reads()).toBe(0);
  });

  // #439-T08
  it("do not exist while billing is off", async () => {
    const t = await start({ billingOn: false });

    await expect(
      t.handlers.change(link("pri_01fake1"), "team"),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    expect(t.reads()).toBe(0);
  });

  // #439-T01
  it("link a price and answer the whole list, with the cached price next to the entered amount", async () => {
    const t = await start();
    await t.setUp();
    const monthly = await t.price();

    const response = await t.handlers.change(link(monthly.id), "team");
    const body = (await response.json()) as { ok: boolean; plans: PlansView };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.ok).toBe(true);
    expect(body.plans.plans[0]).toMatchObject({
      paddleProductId: t.product.id,
      versions: [
        {
          monthlyAmountMinor: 1234,
          monthlyPrice: {
            paddlePriceId: monthly.id,
            amount: "1234",
            drift: null,
          },
          sellable: true,
        },
      ],
    });
  });

  // #439-T07
  it("accept no amount, currency, tax mode or other field in the link, and no PATCH is ever made", async () => {
    const t = await start();
    await t.setUp();
    const monthly = await t.price();

    for (const extra of [
      { amount: 5 },
      { monthlyAmountMinor: 5 },
      { currency: "EUR" },
      { taxMode: "external" },
    ]) {
      const response = await t.handlers.change(link(monthly.id, extra), "team");
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "price_input_invalid",
      });
    }
    // Next to the other changes, not mixed with them.
    const mixed = await t.handlers.change(
      put({
        priceLink: {
          versionNumber: 1,
          interval: "month",
          paddlePriceId: monthly.id,
        },
        archived: true,
      }),
      "team",
    );
    expect(mixed.status).toBe(422);
    expect(await mixed.json()).toMatchObject({ error: "invalid_input" });

    expect((await t.handlers.change(link(monthly.id), "team")).status).toBe(
      200,
    );
    expect(
      (await t.handlers.change(put({ refreshPrices: true }), "team")).status,
    ).toBe(200);
    expect(t.fake.requests().filter((r) => r.method === "PATCH")).toEqual([]);
  });

  // #439-T11
  it("answer a mismatch with its code, the field and both values in minor units, and the status of the code", async () => {
    const t = await start();
    await t.setUp();
    const wrong = await t.price("1235");

    const response = await t.handlers.change(link(wrong.id), "team");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "price_amount_mismatch",
      field: "paddlePriceId",
      issues: [{ field: "paddlePriceId", code: "price_amount_mismatch" }],
      entered: "1234",
      paddle: "1235",
    });
  });

  // #439-T09
  it("answer a Paddle that cannot be reached with a stable code and no text of the failure", async () => {
    const t = await start();
    await t.setUp();
    const monthly = await t.price();
    await t.fake.close();

    const response = await t.handlers.change(link(monthly.id), "team");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "paddle_unreachable" });
  });

  it("answer a plan that does not exist 404 and an id that is no price id 422", async () => {
    const t = await start();
    await t.setUp();

    const ghost = await t.handlers.change(
      json("PUT", "/api/admin/billing/plans/ghost", {
        priceLink: {
          versionNumber: 1,
          interval: "month",
          paddlePriceId: "pri_01fake1",
        },
      }),
      "ghost",
    );
    const junk = await t.handlers.change(link("../x"), "team");

    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toMatchObject({ error: "plan_not_found" });
    expect(junk.status).toBe(422);
    expect(await junk.json()).toMatchObject({ error: "price_id_invalid" });
  });

  // #439-T04
  it("refresh the cache on request and answer the list with the drift", async () => {
    const t = await start();
    await t.setUp();
    const monthly = await t.price();
    await t.handlers.change(link(monthly.id), "team");
    const edited = await fetch(`${t.fake.baseUrl}/prices/${monthly.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${t.fake.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        unit_price: { amount: "1500", currency_code: "USD" },
      }),
    });
    expect(edited.status).toBe(200);

    const response = await t.handlers.change(
      put({ refreshPrices: true }),
      "team",
    );
    const body = (await response.json()) as { plans: PlansView };

    expect(response.status).toBe(200);
    expect(body.plans.plans[0]?.versions[0]).toMatchObject({
      monthlyPrice: { amount: "1500", drift: "price_amount_mismatch" },
      sellable: false,
    });
  });
});
