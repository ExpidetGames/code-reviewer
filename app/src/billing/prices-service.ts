// SPDX-License-Identifier: Apache-2.0

// Linking Paddle prices to a plan version (#439, ADR 0005, 2.11, decision M5): the first, small way to get a sellable plan.
// The operator makes the product and the prices in Paddle and pastes a price id into the slot of the version; the app reads
// that price (`GET /prices/{id}`), checks it against the amount the operator entered for the slot (`price-rules.ts`) and, if
// it is exactly that price, stores what Paddle said. The app never changes a Paddle price and never changes an entered
// amount to fit one: a mismatch is a refusal with both values, a price that changes later is shown as a drift on a refresh.
// Only reads reach Paddle from this module; the client it is given has no other path to a price's money fields anyway.
//
// The plan is bound to its Paddle product by the first price that is linked; every later price must belong to it, and to
// the environment (sandbox or live) billing is set to. A version is linked only while it is the current one: legacy versions
// keep the prices their subscribers bought. Billing off: this service is not reached (the routes answer the missing path).
import "server-only";
import type { Kysely } from "kysely";
import {
  PriceTakenError,
  createBillingPlanPricesRepository,
  type PaddleEnv,
  type PriceSnapshot,
} from "../db/repositories/billing-plan-prices-repository.ts";
import { createBillingPlansRepository } from "../db/repositories/billing-plans-repository.ts";
import { createBillingPlanVersionsRepository } from "../db/repositories/billing-plan-versions-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { BillingCheckErrorCode } from "./admin-errors.ts";
import {
  PaddleClientError,
  type PaddleClient,
  type PaddlePrice,
} from "./paddle-client.ts";
import type { PriceRefusal } from "./price-errors.ts";
import { checkPrice, factsOf, trialDaysOf } from "./price-rules.ts";
import { readBillingSettings } from "./settings.ts";

export type PricesResult = { ok: true } | ({ ok: false } & PriceRefusal);

export type BillingPricesService = {
  /**
   * `{ versionNumber, interval, paddlePriceId }`: links the Paddle price to the slot of the plan's current version
   * (`versionNumber` is the one the caller saw). Nothing else is read from the body: the amount, the currency and the tax
   * mode are the version's and Paddle's, never the request's.
   */
  link(adminId: string, planKey: string, input: unknown): Promise<PricesResult>;
  /** Reads every price of the plan again from Paddle and replaces the cache; drift shows in the plans view. Reads only. */
  refresh(planKey: string): Promise<PricesResult>;
};

export type BillingPricesServiceOptions = {
  db: Kysely<Database>;
  secrets: Pick<SecretStore, "use">;
  /** A client of Paddle for this key and environment. May throw a `PaddleClientError` (a key of the wrong environment). */
  clientFor: (apiKey: string, environment: PaddleEnv) => PaddleClient;
  now?: () => Date;
};

const PRICE_ID = /^pri_[A-Za-z0-9]{1,60}$/;
const LINK_KEYS = ["versionNumber", "interval", "paddlePriceId"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What Paddle's refusal or silence means for the admin. Only the code of the error is read, never its text. */
function paddleRefusal(error: unknown): PriceRefusal {
  if (!(error instanceof PaddleClientError)) throw error;
  switch (error.code) {
    case "not_found":
      return { code: "price_not_found", field: "paddlePriceId" };
    case "unauthorized":
    case "forbidden":
    case "environment_mismatch":
      return { code: "paddle_key_rejected" };
    case "rate_limited":
      return { code: "paddle_rate_limited" };
    case "timeout":
    case "network_error":
      return { code: "paddle_unreachable" };
    default:
      return { code: "paddle_unavailable" };
  }
}

/** The facts the app caches about a price. */
export function snapshotOf(price: PaddlePrice): PriceSnapshot {
  const facts = factsOf(price);
  return {
    productId: price.product_id,
    interval: facts.interval,
    frequency: facts.frequency,
    currency: facts.currency,
    amount: facts.amount,
    taxMode: facts.taxMode,
    hasOverrides: facts.hasOverrides,
    trialDays: trialDaysOf(price.trial_period),
    status: facts.status,
  };
}

export function createBillingPricesService({
  db,
  secrets,
  clientFor,
  now = () => new Date(),
}: BillingPricesServiceOptions): BillingPricesService {
  async function configuredEnvironment(): Promise<PaddleEnv> {
    return readBillingSettings(
      await createInstanceSettingsRepository(db, now).get("billing_settings"),
    ).environment;
  }

  type MadeClient =
    { ok: true; client: PaddleClient } | { ok: false; refusal: PriceRefusal };

  /** A client for the stored key. The key does not leave this function but inside the client. */
  async function storedClient(env: PaddleEnv): Promise<MadeClient> {
    const key = await secrets.use("paddle_api_key");
    if (!key.ok)
      return {
        ok: false,
        refusal: {
          code:
            key.error === "secret_not_configured"
              ? "api_key_missing"
              : "api_key_unreadable",
        } satisfies { code: BillingCheckErrorCode },
      };
    try {
      return { ok: true, client: clientFor(key.value.reveal(), env) };
    } catch (error) {
      return { ok: false, refusal: paddleRefusal(error) };
    }
  }

  function repositories(executor: Kysely<Database>) {
    return {
      plans: createBillingPlansRepository(executor, now),
      versions: createBillingPlanVersionsRepository(executor, now),
      prices: createBillingPlanPricesRepository(executor, now),
    };
  }

  return {
    async link(adminId, planKey, input) {
      void adminId;
      const body = isRecord(input) ? input : undefined;
      const versionNumber = body?.versionNumber;
      const interval = body?.interval;
      const paddlePriceId = body?.paddlePriceId;
      if (
        body === undefined ||
        Object.keys(body).some((key) => !LINK_KEYS.includes(key)) ||
        typeof versionNumber !== "number" ||
        !Number.isSafeInteger(versionNumber) ||
        versionNumber < 1 ||
        (interval !== "month" && interval !== "year") ||
        typeof paddlePriceId !== "string"
      )
        return { ok: false, code: "price_input_invalid" };
      if (!PRICE_ID.test(paddlePriceId))
        return { ok: false, code: "price_id_invalid", field: "paddlePriceId" };

      const { plans, versions, prices } = repositories(db);
      const plan = await plans.get(planKey);
      if (plan === undefined) return { ok: false, code: "plan_not_found" };
      if (plan.kind !== "paid")
        return { ok: false, code: "price_plan_not_paid" };
      if (plan.archivedAt !== null) return { ok: false, code: "plan_archived" };
      const current = await versions.current(plan.id);
      if (current === undefined || current.number !== versionNumber)
        return { ok: false, code: "plan_changed" };
      const entered =
        interval === "month"
          ? current.monthlyAmountMinor
          : current.yearlyAmountMinor;
      if (entered === null)
        return {
          ok: false,
          code: "price_yearly_not_entered",
          field: "interval",
        };

      const env = await configuredEnvironment();
      if (plan.paddleProductEnv !== null && plan.paddleProductEnv !== env)
        return { ok: false, code: "price_environment_mismatch" };
      const known = await prices.getByPaddleId(paddlePriceId);
      if (known !== undefined && known.planId !== plan.id)
        return {
          ok: false,
          code: "price_used_by_other_plan",
          field: "paddlePriceId",
        };
      if (known !== undefined && known.env !== env)
        return { ok: false, code: "price_environment_mismatch" };

      const made = await storedClient(env);
      if (!made.ok) return { ok: false, ...made.refusal };
      let price: PaddlePrice;
      try {
        price = await made.client.getPrice(paddlePriceId);
      } catch (error) {
        return { ok: false, ...paddleRefusal(error) };
      }
      const mismatch = checkPrice(factsOf(price), {
        interval,
        amountMinor: entered,
        productId: plan.paddleProductId,
      });
      if (mismatch !== undefined)
        return { ok: false, ...mismatch, field: "paddlePriceId" };
      const snapshot = snapshotOf(price);

      const store = (): Promise<PricesResult> =>
        db.transaction().execute(async (trx) => {
          const repos = repositories(trx);
          // Looked at again inside the transaction: a new version may have been saved while Paddle was asked.
          const latest = await repos.versions.current(plan.id);
          if (latest === undefined || latest.number !== versionNumber)
            return { ok: false, code: "plan_changed" } as const;
          const bound = await repos.plans.bindProduct(
            plan.id,
            price.product_id,
            env,
          );
          if (bound.env !== env)
            return { ok: false, code: "price_environment_mismatch" } as const;
          if (bound.productId !== price.product_id)
            return { ok: false, code: "price_product_mismatch" } as const;
          const existing = await repos.prices.getByPaddleId(paddlePriceId);
          if (existing !== undefined && existing.planId !== plan.id)
            return {
              ok: false,
              code: "price_used_by_other_plan",
              field: "paddlePriceId",
            } as const;
          const row =
            existing === undefined
              ? await repos.prices.insertLinked({
                  planId: plan.id,
                  paddlePriceId,
                  env,
                  snapshot,
                })
              : await repos.prices.refresh(existing.id, snapshot);
          await repos.versions.setPriceLink(latest.id, interval, row.id);
          return { ok: true } as const;
        });
      try {
        return await store();
      } catch (error) {
        // Two admins linked the same new price at once: the other row exists now, and the second try refreshes it.
        if (!(error instanceof PriceTakenError)) throw error;
        return store();
      }
    },

    async refresh(planKey) {
      const { plans, prices } = repositories(db);
      const plan = await plans.get(planKey);
      if (plan === undefined) return { ok: false, code: "plan_not_found" };
      if (plan.kind !== "paid")
        return { ok: false, code: "price_plan_not_paid" };
      const env = await configuredEnvironment();
      // A price of the other environment cannot be read with this key; it shows as a drift instead.
      const rows = (await prices.listForPlan(plan.id)).filter(
        (row) => row.env === env && row.paddlePriceId !== null,
      );
      if (rows.length === 0) return { ok: true };
      const made = await storedClient(env);
      if (!made.ok) return { ok: false, ...made.refusal };
      for (const row of rows) {
        if (row.paddlePriceId === null) continue;
        let price: PaddlePrice;
        try {
          price = await made.client.getPrice(row.paddlePriceId);
        } catch (error) {
          return { ok: false, ...paddleRefusal(error) };
        }
        await prices.refresh(row.id, snapshotOf(price));
      }
      return { ok: true };
    },
  };
}
