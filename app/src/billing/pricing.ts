// SPDX-License-Identifier: LicenseRef-Proprietary

// The price of a run and the hold of a job (ADR 0006, 2.4, 2.6, 2.8 and D6): one pure module that turns the facts of a run
// into the two amounts the customer sees. No database, no clock, no network, and no floating point on an amount: every
// amount is a whole number of micro-USD, computed in BigInt and rounded half up once, separately for AI and
// infrastructure. A result that does not fit the safe integer range is refused, never wrapped. See README.md.
import "server-only";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";
import type { OutcomeClass } from "./outcome.ts";
import {
  FACTOR_A_SCALE,
  isDiffAiReserve,
  isFactorA,
  isMinuteRate,
  type BillingRates,
} from "./rates.ts";

/** Stable codes of a price that cannot be computed. */
export const PRICING_ERROR_CODES = [
  /** A fact of the run is no whole, non-negative number in the safe integer range. */
  "pricing_input_invalid",
  /** The rates are not valid (they pass `validateRatesPatch` when they are stored, so this is damaged data). */
  "pricing_rates_invalid",
  /** An amount is above the safe integer range. */
  "pricing_amount_overflow",
] as const;
export type PricingErrorCode = (typeof PRICING_ERROR_CODES)[number];

export class PricingError extends Error {
  /** The message names the code only, never a figure. */
  readonly safeMessage = true as const;
  readonly code: PricingErrorCode;

  constructor(code: PricingErrorCode) {
    super(code);
    this.name = "PricingError";
    this.code = code;
  }
}

/** The two prices the customer sees, and their sum. Whole micro-USD, never negative. */
export type RunPrice = {
  aiMicroUsd: number;
  infraMicroUsd: number;
  totalMicroUsd: number;
};

export type PriceRunInput = {
  keyMode: KeyMode;
  outcomeClass: OutcomeClass;
  /** The real model cost in micro-USD (`usage_records.cost_micro_usd`); null when unknown. */
  costMicroUsd: number | null;
  /** Whole started minutes of the VM's life; 0 when no VM ever started. */
  billableMinutes: number;
  reviewKind: ProjectReviewKind;
  rates: BillingRates;
};

const NOTHING: RunPrice = { aiMicroUsd: 0, infraMicroUsd: 0, totalMicroUsd: 0 };
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const HALF = BigInt(FACTOR_A_SCALE) / BigInt(2);

function wholeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new PricingError("pricing_input_invalid");
  return value;
}

function checkedRates(rates: BillingRates): BillingRates {
  if (
    !isFactorA(rates.factorA) ||
    !isMinuteRate(rates.minuteRateMicroUsd.diff) ||
    !isMinuteRate(rates.minuteRateMicroUsd.dynamic) ||
    !isDiffAiReserve(rates.diffAiReserveMicroUsd)
  )
    throw new PricingError("pricing_rates_invalid");
  return rates;
}

/** A whole amount of the safe range, or a refusal. */
function toAmount(value: bigint): number {
  if (value > MAX_SAFE) throw new PricingError("pricing_amount_overflow");
  return Number(value);
}

/** `round(cost x A / 10,000)`, half up, in integers. */
function aiAmount(costMicroUsd: number, factorA: number): number {
  const scaled = BigInt(costMicroUsd) * BigInt(factorA);
  return toAmount((scaled + HALF) / BigInt(FACTOR_A_SCALE));
}

/** `minutes x B`: both whole, so the product is exact and needs no rounding. */
function infraAmount(minutes: number, rate: number): number {
  return toAmount(BigInt(minutes) * BigInt(rate));
}

function priceOf(aiMicroUsd: number, infraMicroUsd: number): RunPrice {
  return {
    aiMicroUsd,
    infraMicroUsd,
    totalMicroUsd: toAmount(BigInt(aiMicroUsd) + BigInt(infraMicroUsd)),
  };
}

/**
 * The price of one finished run. The AI price is the cost times A for a run on the managed key whose class is `charged`
 * and whose cost is known, else 0. The infrastructure price is the started minutes times B of the review kind, unless the
 * class is `free`. Each is rounded once, alone. There is no minimum: a run that costs nothing charges nothing.
 *
 * The facts of a `free` run are not looked at (a run that costs nothing needs no valid number), and the cost is looked at
 * only when it is used (the managed key, class `charged`, cost known). Anything else with a fact that is not a whole,
 * non-negative number, or rates that are not valid, or an amount above the safe integer range, throws a `PricingError`:
 * the caller decides what a run that cannot be priced does.
 */
export function priceRun(input: PriceRunInput): RunPrice {
  if (input.outcomeClass === "free") return NOTHING;
  const rates = checkedRates(input.rates);
  const minutes = wholeNumber(input.billableMinutes);
  // The cost is read only when it is used: a bad cost field cannot block the minutes of a run that charges no AI.
  const withAi =
    input.keyMode === "managed" &&
    input.outcomeClass === "charged" &&
    input.costMicroUsd !== null;
  return priceOf(
    withAi ? aiAmount(wholeNumber(input.costMicroUsd), rates.factorA) : 0,
    infraAmount(minutes, rates.minuteRateMicroUsd[input.reviewKind]),
  );
}

export type ReserveInput = {
  keyMode: KeyMode;
  reviewKind: ProjectReviewKind;
  /** The longest the VM lives (job timeout plus the margin), in minutes; a fraction is a started minute. */
  maxMinutes: number;
  rates: BillingRates;
  /** The cost limit of a Dynamic job; read only for Dynamic on the managed key. */
  dynamicCostLimitMicroUsd: number | null;
};

/**
 * The hold of a job (ADR 0006, D6): the longest the VM lives times B, plus for the managed key `round(AI budget x A)`,
 * where the AI budget is the job's cost limit for Dynamic and the admin's reserve for Diff (both real model cost, before
 * A). A hold is not a price: settlement charges what the run really cost, even above it.
 *
 * This is the **full** hold. Decision 5 of #489 (reserve at most the available balance; the final charge may take the
 * balance slightly negative) is applied by the caller, #498, for example `min(hold, available)`; not here.
 */
export function reserveFor(input: ReserveInput): RunPrice {
  const rates = checkedRates(input.rates);
  const { maxMinutes } = input;
  if (
    typeof maxMinutes !== "number" ||
    !Number.isFinite(maxMinutes) ||
    maxMinutes < 0
  )
    throw new PricingError("pricing_input_invalid");
  // Minutes are not an amount: a started minute is a whole one.
  const minutes = wholeNumber(Math.ceil(maxMinutes));
  const infra = infraAmount(
    minutes,
    rates.minuteRateMicroUsd[input.reviewKind],
  );
  if (input.keyMode !== "managed") return priceOf(0, infra);
  const budget =
    input.reviewKind === "dynamic"
      ? wholeNumber(input.dynamicCostLimitMicroUsd)
      : rates.diffAiReserveMicroUsd;
  return priceOf(aiAmount(budget, rates.factorA), infra);
}
