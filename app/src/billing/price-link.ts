// SPDX-License-Identifier: Apache-2.0

// The one way a Paddle price becomes the price of a slot of a plan version (#439, #440): the price is judged by the rules of
// `price-rules.ts` against the amount the operator entered for the slot, what Paddle said is stored, and the slot is set in
// one transaction by a compare-and-set against the link it held when it was read, on the current version only. A price the
// operator pastes (`prices-service.ts`, `link`) and a price the app created (`prices-create.ts`) both go through here: there
// is no second way to link. Reads nothing from Paddle and writes nothing to it.
import "server-only";
import type { Kysely } from "kysely";
import {
  PriceTakenError,
  createBillingPlanPricesRepository,
  type PaddleEnv,
  type PriceSnapshot,
} from "../db/repositories/billing-plan-prices-repository.ts";
import {
  createBillingPlansRepository,
  type PlanRow,
} from "../db/repositories/billing-plans-repository.ts";
import { createBillingPlanVersionsRepository } from "../db/repositories/billing-plan-versions-repository.ts";
import type { Database } from "../db/schema.ts";
import type { PaddlePrice } from "./paddle-client.ts";
import type { PriceRefusal } from "./price-errors.ts";
import {
  checkPrice,
  factsOf,
  trialDaysOf,
  type PriceInterval,
} from "./price-rules.ts";

export type PricesResult = { ok: true } | ({ ok: false } & PriceRefusal);

/** Thrown inside the link transaction to undo it: nothing a refused link started (the product binding, the row) stays. */
export class Refused extends Error {
  readonly refusal: PriceRefusal;
  constructor(refusal: PriceRefusal) {
    super(refusal.code);
    this.refusal = refusal;
  }
}

/** The facts the app caches about a price. */
export function snapshotOf(price: PaddlePrice): PriceSnapshot {
  const facts = factsOf(price);
  return {
    productId: price.product_id,
    priceType: facts.priceType,
    interval: facts.interval,
    frequency: facts.frequency,
    currency: facts.currency,
    amount: facts.amount,
    taxMode: facts.taxMode,
    hasOverrides: facts.hasOverrides,
    trialDays: trialDaysOf(price.trial_period),
    quantityMinimum: facts.quantityMinimum,
    quantityMaximum: facts.quantityMaximum,
    status: facts.status,
  };
}

export function repositoriesOf(executor: Kysely<Database>, now: () => Date) {
  return {
    plans: createBillingPlansRepository(executor, now),
    versions: createBillingPlanVersionsRepository(executor, now),
    prices: createBillingPlanPricesRepository(executor, now),
  };
}

export type LinkRequest = {
  plan: PlanRow;
  /** The version number the caller saw; the write is made only if it is still the current one. */
  versionNumber: number;
  interval: PriceInterval;
  /** The link the slot held when it was read; `null` for an empty slot. The write is made only if it holds it still. */
  expectedLink: string | null;
  /** The amount entered for the slot, minor units. */
  entered: number;
  env: PaddleEnv;
  paddlePriceId: string;
  price: PaddlePrice;
};

export type LinkContext = { db: Kysely<Database>; now: () => Date };

/** Judges the price against the slot and, if it is exactly that price, stores it and links it. */
export async function linkPrice(
  { db, now }: LinkContext,
  request: LinkRequest,
): Promise<PricesResult> {
  const { plan, versionNumber, interval, expectedLink, env, price } = request;
  const { paddlePriceId } = request;
  const mismatch = checkPrice(factsOf(price), {
    interval,
    amountMinor: request.entered,
    productId: plan.paddleProductId,
  });
  if (mismatch !== undefined)
    return { ok: false, ...mismatch, field: "paddlePriceId" };
  const snapshot = snapshotOf(price);

  const store = async (): Promise<PricesResult> => {
    try {
      return await db.transaction().execute(async (trx) => {
        const repos = repositoriesOf(trx, now);
        // Looked at again inside the transaction: a new version may have been saved while Paddle was asked.
        const latest = await repos.versions.current(plan.id);
        if (latest === undefined || latest.number !== versionNumber)
          throw new Refused({ code: "plan_changed" });
        const bound = await repos.plans.bindProduct(
          plan.id,
          price.product_id,
          env,
        );
        if (bound.env !== env)
          throw new Refused({ code: "price_environment_mismatch" });
        if (bound.productId !== price.product_id)
          throw new Refused({ code: "price_product_mismatch" });
        const existing = await repos.prices.getByPaddleId(paddlePriceId);
        if (existing !== undefined && existing.planId !== plan.id)
          throw new Refused({
            code: "price_used_by_other_plan",
            field: "paddlePriceId",
          });
        // A price the app created has its row already (`prices-create.ts` records it before it links), so it is refreshed.
        const row =
          existing === undefined
            ? await repos.prices.insertLinked({
                planId: plan.id,
                paddlePriceId,
                env,
                snapshot,
              })
            : await repos.prices.refresh(existing.id, snapshot);
        // The read above proves nothing on Postgres once another admin commits: the write itself only hits the current version.
        const linked = await repos.versions.setPriceLink(
          latest.id,
          interval,
          row.id,
          expectedLink,
        );
        if (!linked.ok)
          throw new Refused({
            code:
              linked.reason === "link_changed"
                ? "price_link_changed"
                : "plan_changed",
          });
        return { ok: true } as const;
      });
    } catch (error) {
      if (error instanceof Refused) return { ok: false, ...error.refusal };
      throw error;
    }
  };
  try {
    return await store();
  } catch (error) {
    // Two admins linked the same new price at once: the other row exists now, and the second try refreshes it.
    if (!(error instanceof PriceTakenError)) throw error;
    return store();
  }
}
