// SPDX-License-Identifier: Apache-2.0

// Whether a Paddle price is the price of a plan version (#439, ADR 0005, 2.11). Pure: no database, no Paddle. A plan version
// holds the amounts the operator entered (a monthly price and an optional yearly price, USD, tax inclusive, minor units);
// a price the operator links must carry exactly the amount of its slot. The app never edits the Paddle price to make it
// fit and never edits the amount to make the price fit: a difference is a refusal with both values, or, for a price that was
// linked and changed since, a drift badge.
//
// The checks run in a fixed order and report one code, so the same price always gets the same answer: not active, not
// recurring, interval, currency, tax mode, amount, overrides, quantity, product. Linking additionally refuses a price that cannot be
// found, one from another environment and a yearly price on a version without one (before Paddle is asked, or from its
// 404); those codes are here so the list is in one place.
import "server-only";
import type { PaddlePrice } from "./paddle-schemas.ts";

export const PRICE_RULE_ERROR_CODES = [
  /** Paddle does not know this price. */
  "price_not_found",
  /** The price is archived. */
  "price_not_active",
  /** A one-time price, not a subscription price. */
  "price_not_recurring",
  /** The price does not carry the amount entered for the slot (`entered` and `paddle` in minor units). */
  "price_amount_mismatch",
  /** Not every 1 month for the monthly slot, not every 1 year for the yearly slot. */
  "price_interval_mismatch",
  /** The price is not in USD. */
  "price_currency_mismatch",
  /** The tax mode is not `internal` (prices are tax inclusive); `account_setting` is refused, it depends on the account. */
  "price_tax_mode_mismatch",
  /** The price has country overrides. */
  "price_has_overrides",
  /** The price cannot be bought with a quantity of one: its minimum is above one or its maximum below one. */
  "price_quantity_unsupported",
  /** The price belongs to another product than the plan's. */
  "price_product_mismatch",
  /** The price (or the plan's product) is from the other Paddle environment than the configured one. */
  "price_environment_mismatch",
  /** A yearly price on a version without a yearly price. */
  "price_yearly_not_entered",
] as const;
export type PriceRuleErrorCode = (typeof PRICE_RULE_ERROR_CODES)[number];

/** The only currency (ADR 0005, M12). */
export const PRICE_CURRENCY = "USD";
/** What stands for a currency Paddle sent that is not a code (see `currencyOf`): shown and cached instead of Paddle's text. */
export const UNKNOWN_CURRENCY = "???";
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Paddle's text is untrusted and this one is cached and shown: only three capital letters pass, the rest is a placeholder. */
function currencyOf(code: string): string {
  return CURRENCY_CODE.test(code) ? code : UNKNOWN_CURRENCY;
}

/** Tax inclusive, and explicit: `account_setting` would depend on the account default. */
export const PRICE_TAX_MODE = "internal";

export type PriceInterval = "month" | "year";

/** What a slot of a version expects of its Paddle price. */
export type PriceExpectation = {
  interval: PriceInterval;
  /** The amount entered for the slot, USD minor units. */
  amountMinor: number;
  /** The plan's Paddle product; `null` while no price of the plan has been linked (the first price sets it). */
  productId: string | null;
};

/** The facts of a price the rules read: from Paddle's answer when linking, from the cache when judging drift. */
export type PriceFacts = {
  status: string;
  recurring: boolean;
  interval: string;
  frequency: number;
  currency: string;
  taxMode: string;
  /** Paddle's own string of minor units. */
  amount: string;
  hasOverrides: boolean;
  /** The limits of the quantity of one item: a subscription is bought with a quantity of one. */
  quantityMinimum: number;
  quantityMaximum: number;
  productId: string;
};

export type PriceMismatch = {
  code: PriceRuleErrorCode;
  /** What the version holds, as text (minor units for an amount); left out for a check without two values. */
  entered?: string;
  /** What Paddle says. */
  paddle?: string;
};

export function factsOf(price: PaddlePrice): PriceFacts {
  return {
    status: price.status,
    recurring: price.billing_cycle !== null,
    interval: price.billing_cycle?.interval ?? "",
    frequency: price.billing_cycle?.frequency ?? 0,
    currency: currencyOf(price.unit_price.currency_code),
    taxMode: price.tax_mode,
    amount: price.unit_price.amount,
    hasOverrides: (price.unit_price_overrides ?? []).length > 0,
    quantityMinimum: price.quantity.minimum,
    quantityMaximum: price.quantity.maximum,
    productId: price.product_id,
  };
}

/**
 * Whether Paddle's string of minor units is the entered number. Both are integers and are compared as integers: a decimal
 * point, an exponent, a sign or a space is not an amount, and a number too large for a float keeps all its digits.
 */
export function amountEquals(entered: number, paddleAmount: string): boolean {
  if (!/^[0-9]{1,30}$/.test(paddleAmount)) return false;
  if (!Number.isSafeInteger(entered) || entered < 0) return false;
  return BigInt(paddleAmount) === BigInt(entered);
}

function intervalText(facts: PriceFacts): string {
  return facts.frequency === 1
    ? facts.interval
    : `${facts.frequency} ${facts.interval}s`;
}

/** The first thing that makes `facts` not the price of the slot, or `undefined` when it is exactly that price. */
export function checkPrice(
  facts: PriceFacts,
  expected: PriceExpectation,
): PriceMismatch | undefined {
  if (facts.status !== "active") return { code: "price_not_active" };
  if (!facts.recurring) return { code: "price_not_recurring" };
  if (facts.interval !== expected.interval || facts.frequency !== 1)
    return {
      code: "price_interval_mismatch",
      entered: expected.interval,
      paddle: intervalText(facts),
    };
  if (facts.currency !== PRICE_CURRENCY)
    return {
      code: "price_currency_mismatch",
      entered: PRICE_CURRENCY,
      paddle: facts.currency,
    };
  if (facts.taxMode !== PRICE_TAX_MODE)
    return {
      code: "price_tax_mode_mismatch",
      entered: PRICE_TAX_MODE,
      paddle: facts.taxMode,
    };
  if (!amountEquals(expected.amountMinor, facts.amount))
    return {
      code: "price_amount_mismatch",
      entered: String(expected.amountMinor),
      paddle: facts.amount,
    };
  if (facts.hasOverrides) return { code: "price_has_overrides" };
  // Checkout opens a subscription with a quantity of one (ADR 0005): Paddle refuses a transaction below the minimum.
  if (facts.quantityMinimum !== 1 || facts.quantityMaximum < 1)
    return {
      code: "price_quantity_unsupported",
      entered: "1",
      paddle: `${facts.quantityMinimum} to ${facts.quantityMaximum}`,
    };
  if (expected.productId !== null && facts.productId !== expected.productId)
    return { code: "price_product_mismatch" };
  return undefined;
}

const DAYS_PER = { day: 1, week: 7, month: 30, year: 365 } as const;

/**
 * The trial of a price in days, read from Paddle (the app does not set one on a linked price); `null` for none. A trial
 * counted in months or years is the number of days of a 30 day month or a 365 day year: for display only.
 */
export function trialDaysOf(
  trial:
    { interval: keyof typeof DAYS_PER; frequency: number } | null | undefined,
): number | null {
  if (trial === null || trial === undefined) return null;
  return trial.frequency * DAYS_PER[trial.interval];
}
