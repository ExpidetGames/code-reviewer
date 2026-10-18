// SPDX-License-Identifier: Apache-2.0

// Creating and archiving Paddle prices on the plans routes (#440): for the instance admin only, absent while billing is off, one
// change per request, with no field for an amount, a currency, an interval or a tax mode, and every refusal a stable code that
// carries nothing Paddle said. The fake Paddle is behind the real prices service; the portal around the routes is tested by
// src/admin, so these tests hand the handlers the access result directly.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { AdminAccess } from "../admin/access.ts";
import type { PlansView } from "../admin/ui/plans-view.ts";
import type { Database } from "../db/schema.ts";
import { createSecretStore } from "../secrets/store.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { NotFoundSignal } from "../test-support/admin-harness.ts";
import { clientFor, startTestPaddle } from "../test-support/paddle-fake.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { createPlansRouteHandlers } from "./plans-http.ts";
import { createBillingPlansService } from "./plans-service.ts";
import { createBillingPricesService } from "./prices-service.ts";

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
    limits: {
      diffRunsPerPeriod: 40,
      dynamicRunsPerPeriod: 8,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    modelAccess: { catalogEntries: null },
    monthlyAmountMinor: 1234,
    yearlyAmountMinor: 12_340,
  },
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

function json(method: string, path: string, body: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const put = (body: unknown) =>
  json("PUT", "/api/admin/billing/plans/team", body);

async function startOn(
  open: () => Promise<Kysely<Database>>,
  options: { access?: AdminAccess; billingOn?: boolean } = {},
) {
  const db = await open();
  const admin = await insertUser(db, { id: "admin-1", isInstanceAdmin: true });
  await setBillingSwitch(db, true);
  const fake = await startTestPaddle();
  const secrets = createSecretStore({
    db,
    appSecret: "prices-create-http-test-secret-0123456789-0123",
  });
  await secrets.save("paddle_api_key", fake.apiKey, { updatedBy: admin });
  const access: AdminAccess =
    options.access ?? ({ kind: "admin", user: { id: admin } } as AdminAccess);
  let clients = 0;
  const handlers = createPlansRouteHandlers({
    access: () => Promise.resolve(access),
    notFound: () => {
      throw new NotFoundSignal();
    },
    isOn: () => Promise.resolve(options.billingOn ?? true),
    service: createBillingPlansService({ db }),
    prices: createBillingPricesService({
      db,
      secrets,
      clientFor: () => {
        clients += 1;
        return clientFor(fake);
      },
    }),
  });
  return {
    handlers,
    fake,
    clients: () => clients,
    async setUp() {
      const response = await handlers.create(
        json("POST", "/api/admin/billing/plans", NEW_PLAN),
      );
      expect(response.status).toBe(200);
    },
  };
}

describe.each(ENGINES)(
  "creating and archiving Paddle prices on the plans routes on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;
    const start = (options: Parameters<typeof startOn>[1] = {}) =>
      startOn(engine.open, options);

    // #440-T10
    it_("answer an anonymous caller 401 and call nobody", async () => {
      const t = await start({ access: { kind: "anonymous" } as AdminAccess });

      for (const body of [
        { createPrices: { versionNumber: 1 } },
        { archivePrice: { paddlePriceId: "pri_01fake1" } },
      ]) {
        const response = await t.handlers.change(put(body), "team");
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      }
      expect(t.clients()).toBe(0);
      expect(t.fake.requests()).toEqual([]);
    });

    // #440-T10
    it_(
      "answer somebody who is not an admin as a path that does not exist",
      async () => {
        const t = await start({ access: { kind: "not_admin" } as AdminAccess });

        await expect(
          t.handlers.change(
            put({ createPrices: { versionNumber: 1 } }),
            "team",
          ),
        ).rejects.toBeInstanceOf(NotFoundSignal);
        await expect(
          t.handlers.change(
            put({ archivePrice: { paddlePriceId: "pri_01fake1" } }),
            "team",
          ),
        ).rejects.toBeInstanceOf(NotFoundSignal);
        expect(t.clients()).toBe(0);
        expect(t.fake.requests()).toEqual([]);
      },
    );

    // #440-T10
    it_("do not exist while billing is off", async () => {
      const t = await start({ billingOn: false });

      await expect(
        t.handlers.change(put({ createPrices: { versionNumber: 1 } }), "team"),
      ).rejects.toBeInstanceOf(NotFoundSignal);
      expect(t.fake.requests()).toEqual([]);
    });

    // #440-T01
    it_(
      "create the prices and answer the whole list with the prices linked and nothing left over",
      async () => {
        const t = await start();
        await t.setUp();

        const response = await t.handlers.change(
          put({ createPrices: { versionNumber: 1, trialDays: 7 } }),
          "team",
        );
        const body = (await response.json()) as {
          ok: boolean;
          plans: PlansView;
        };

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(body.ok).toBe(true);
        expect(body.plans.plans[0]).toMatchObject({
          paddleProductId: t.fake.products()[0]?.id,
          priceAttempts: [],
          versions: [
            {
              sellable: true,
              monthlyPrice: { amount: "1234", trialDays: 7, drift: null },
              yearlyPrice: { amount: "12340", trialDays: 7, drift: null },
            },
          ],
        });
      },
    );

    // #440-T13
    it_(
      "accept no amount, currency, interval, tax mode or other field in the create, and send nothing to Paddle",
      async () => {
        const t = await start();
        await t.setUp();

        for (const extra of [
          { amount: 5 },
          { monthlyAmountMinor: 5 },
          { currency: "EUR" },
          { interval: "year" },
          { taxMode: "external" },
          { unit_price: { amount: "5", currency_code: "USD" } },
        ]) {
          const response = await t.handlers.change(
            put({ createPrices: { versionNumber: 1, ...extra } }),
            "team",
          );
          expect(response.status, JSON.stringify(extra)).toBe(422);
          expect(await response.json()).toMatchObject({
            error: "price_input_invalid",
          });
        }
        // The route has one change per request, and the create is not mixed with another.
        for (const body of [
          { createPrices: { versionNumber: 1 }, refreshPrices: true },
          { createPrices: "yes" },
          { createPrices: null },
        ]) {
          const response = await t.handlers.change(put(body), "team");
          expect(response.status).toBe(422);
        }

        expect(t.fake.requests()).toEqual([]);
      },
    );

    // #440-T04
    it_(
      "answer a refused create with a stable code, the slot to blame, the status of the code and no word from Paddle",
      async () => {
        const t = await start();
        await t.setUp();
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

        const response = await t.handlers.change(
          put({ createPrices: { versionNumber: 1 } }),
          "team",
        );
        const text = await response.text();

        expect(response.status).toBe(502);
        expect(JSON.parse(text)).toEqual({
          error: "price_create_rejected",
          field: "month",
          issues: [{ field: "month", code: "price_create_rejected" }],
        });
        expect(text).not.toContain("PADDLE-DETAIL");
      },
    );

    // #440-T09
    it_(
      "answer a create that another request is doing 409 with its own code",
      async () => {
        const t = await start();
        await t.setUp();
        t.fake.faults.delay({ method: "POST", path: "/prices" }, 300, {
          times: 2,
        });
        const first = t.handlers.change(
          put({ createPrices: { versionNumber: 1 } }),
          "team",
        );
        for (
          let tries = 0;
          tries < 400 &&
          !t.fake
            .requests()
            .some((r) => r.method === "POST" && r.path === "/prices");
          tries += 1
        )
          await new Promise((resolve) => setTimeout(resolve, 5));

        const second = await t.handlers.change(
          put({ createPrices: { versionNumber: 1 } }),
          "team",
        );

        expect(second.status).toBe(409);
        expect(await second.json()).toMatchObject({
          error: "price_creation_pending",
          field: "month",
        });
        expect((await first).status).toBe(200);
        expect(t.fake.prices()).toHaveLength(2);
      },
    );

    // #440-T08
    it_(
      "archive a price nobody uses and answer the whole list, and refuse one a live subscription uses",
      async () => {
        const t = await start();
        await t.setUp();
        await t.handlers.change(
          put({ createPrices: { versionNumber: 1 } }),
          "team",
        );
        // New terms: version 1 is legacy, its prices are free to archive when nobody uses them.
        const saved = await t.handlers.change(
          put({
            terms: {
              basedOnVersion: 1,
              terms: {
                ...NEW_PLAN.terms,
                limits: { ...NEW_PLAN.terms.limits, diffRunsPerPeriod: 60 },
              },
            },
          }),
          "team",
        );
        expect(saved.status).toBe(200);
        const [monthly, yearly] = t.fake.prices();
        if (monthly === undefined || yearly === undefined)
          throw new Error("no prices");
        t.fake.seedSubscription({ priceId: monthly.id });

        const refused = await t.handlers.change(
          put({ archivePrice: { paddlePriceId: monthly.id } }),
          "team",
        );
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({
          error: "price_has_subscribers",
          field: "paddlePriceId",
        });

        const archived = await t.handlers.change(
          put({ archivePrice: { paddlePriceId: yearly.id } }),
          "team",
        );
        expect(archived.status).toBe(200);
        expect(((await archived.json()) as { ok: boolean }).ok).toBe(true);
        expect(t.fake.prices()[1]?.status).toBe("archived");
      },
    );
  },
);
