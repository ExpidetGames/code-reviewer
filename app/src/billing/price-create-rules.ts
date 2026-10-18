// SPDX-License-Identifier: Apache-2.0

// Creating the Paddle price of a plan version (#440, ADR 0005, 2.11): the pure part. The amount, the currency, the tax mode and
// the interval of a price the app creates are never a caller's choice: the amount is the one entered for the version (#438),
// the rest are the constants of `price-rules.ts`. What Paddle is asked is built here from those and nowhere else, so the
// price the app creates is the price `checkPrice` accepts. No database, no Paddle.
import "server-only";
import type { CreatePriceInput, CreateProductInput } from "./paddle-client.ts";
import type { PaddlePrice, PaddleProduct } from "./paddle-schemas.ts";
import {
  PRICE_CURRENCY,
  PRICE_TAX_MODE,
  PRICE_TYPE,
  type PriceInterval,
} from "./price-rules.ts";

/** The longest trial the form takes: a year of days. A trial is optional and off by default (decision M17). */
export const MAX_TRIAL_DAYS = 365;

/**
 * The amount to send for a version's stored amount: a positive whole number of minor units, as the string Paddle takes. The
 * form has no amount field; this guards the stored data (a value that cannot be a price is refused before Paddle is asked).
 */
export function amountToCreate(
  stored: unknown,
): { ok: true; amount: string } | { ok: false } {
  if (typeof stored !== "number" || !Number.isSafeInteger(stored) || stored < 1)
    return { ok: false };
  return { ok: true, amount: String(stored) };
}

/** The trial days of a create request: none, or a whole number from 1 to `MAX_TRIAL_DAYS`. */
export function trialDaysToCreate(
  given: unknown,
): { ok: true; days: number | null } | { ok: false } {
  if (given === undefined || given === null) return { ok: true, days: null };
  if (
    typeof given !== "number" ||
    !Number.isSafeInteger(given) ||
    given < 1 ||
    given > MAX_TRIAL_DAYS
  )
    return { ok: false };
  return { ok: true, days: given };
}

/**
 * The name of one attempt to create the price of a slot. The same version, slot and trial always give the same name, so a
 * second click, a second admin and a retry after a lost answer all meet the row of the first attempt; another version, slot or
 * trial is another attempt. It is written to the intent row and to the price's custom data at Paddle.
 */
export function intentIdOf(input: {
  versionId: string;
  interval: PriceInterval;
  trialDays: number | null;
}): string {
  return `cri_${input.versionId}_${input.interval}_${input.trialDays ?? 0}`;
}

const WORDS = { month: "Monthly", year: "Yearly" } as const;

/** The body of `POST /prices`. Fixed keys, no overrides: a created price is the price of the slot and nothing more. */
export function priceRequestOf(input: {
  planKey: string;
  intentId: string;
  productId: string;
  interval: PriceInterval;
  /** Minor units, from `amountToCreate`. */
  amount: string;
  trialDays: number | null;
}): CreatePriceInput {
  return {
    product_id: input.productId,
    type: PRICE_TYPE,
    description: `${WORDS[input.interval]} price of the plan ${input.planKey}`,
    unit_price: { amount: input.amount, currency_code: PRICE_CURRENCY },
    billing_cycle: { interval: input.interval, frequency: 1 },
    ...(input.trialDays === null
      ? {}
      : { trial_period: { interval: "day", frequency: input.trialDays } }),
    tax_mode: PRICE_TAX_MODE,
    // A subscription is bought with a quantity of one (`price_quantity_unsupported`).
    quantity: { minimum: 1, maximum: 1 },
    custom_data: { cr_plan_key: input.planKey, cr_intent: input.intentId },
  };
}

/**
 * Whether Paddle's price is the one an attempt created: active, and its custom data names this intent and this plan. Paddle
 * has no key for a create, so after a lost answer this is how the price is found again. The custom data is Paddle's text
 * and is compared, never trusted for anything else: the price is then judged by the same rules as any other.
 */
export function matchesIntent(
  price: PaddlePrice,
  intentId: string,
  planKey: string,
): boolean {
  if (price.status !== "active") return false;
  const data = price.custom_data;
  if (data === null || data === undefined) return false;
  return data.cr_intent === intentId && data.cr_plan_key === planKey;
}

/** The name of the attempt to create the Paddle product of a plan: one per plan, written to the product's custom data. */
export function productIntentOf(planId: string): string {
  return `crp_${planId}`;
}

/** The body of `POST /products`: the plan's name, the software category (available on every Paddle account) and the intent. */
export function productRequestOf(input: {
  planKey: string;
  planId: string;
  name: string;
}): CreateProductInput {
  return {
    name: input.name,
    tax_category: "saas",
    type: "standard",
    custom_data: {
      cr_plan_key: input.planKey,
      cr_intent: productIntentOf(input.planId),
    },
  };
}

/** Whether Paddle's product is the one an attempt created for this plan: active, with the plan's intent and key. */
export function matchesProductIntent(
  product: PaddleProduct,
  planId: string,
  planKey: string,
): boolean {
  if (product.status !== "active") return false;
  const data = product.custom_data;
  if (data === null || data === undefined) return false;
  return (
    data.cr_intent === productIntentOf(planId) && data.cr_plan_key === planKey
  );
}
