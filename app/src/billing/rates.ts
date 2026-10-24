// SPDX-License-Identifier: LicenseRef-Proprietary

// The rates of billing (ADR 0006, 2.4 and D2/D3): the factor A of the operator's key, the rate B per started minute for
// each review kind, and the AI reserve of a Diff review. Pure: the bounds, the validation with its stable codes, and
// the question whether a stored set is complete. Every amount is a whole number (no floating point is stored or read).
// No number has a default in code: A, both B and the reserve are admin data (D3), and billing cannot be switched on
// before all four are set.
import "server-only";
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/** A is stored in parts per 10,000: 1.2 is 12,000. */
export const FACTOR_A_SCALE = 10_000;
export const FACTOR_A_MIN = 10_000;
export const FACTOR_A_MAX = 1_000_000;
/** The largest B: ten US dollars per started minute is far above any VM. */
export const MINUTE_RATE_MAX_MICRO_USD = 10_000_000;
/**
 * The largest AI reserve of a Diff review: fifty US dollars of real model cost.
 *
 * The reserve is the AI part of the hold of a Diff job, which has no enforced cost cap. It is measured in **real model
 * cost** (micro-USD, before the factor A), the unit of the Dynamic cost limit, and `reserveFor` multiplies it by A. A is
 * therefore not a way to change the real-cost margin of the hold. The admin form (#504) labels it "real model cost,
 * before the factor". It has no default: a number nobody decided must not hold a customer's balance. A hold is not a
 * price: settlement charges what the run really cost.
 */
export const DIFF_AI_RESERVE_MAX_MICRO_USD = 50_000_000;

/**
 * The numbers next to the rates that the admin page sets (#504, ADR 0006 D3, D9, D10). They are not prices, so they have a
 * default where the decision record says so: the start credit is 2 USD (0 switches it off), a balance is low below 5 USD
 * and the hourly brake lets 60 started reviews of a workspace through in a rolling hour. A start credit is a gift, so it
 * is bounded well below the largest top-up.
 */
export const DEFAULT_START_CREDIT_MICRO_USD = 2_000_000;
export const START_CREDIT_MAX_MICRO_USD = 100_000_000;
export const DEFAULT_LOW_BALANCE_MICRO_USD = 5_000_000;
/** As large as the largest top-up (500 USD): a threshold above what a workspace can buy at once warns forever. */
export const LOW_BALANCE_MAX_MICRO_USD = 500_000_000;
export const DEFAULT_HOURLY_REVIEW_LIMIT = 60;
export const HOURLY_REVIEW_LIMIT_MIN = 1;
export const HOURLY_REVIEW_LIMIT_MAX = 100_000;

/** Stable codes of a refused rate or number; the admin form translates them to copy (#504). */
export const BILLING_RATE_ERROR_CODES = [
  "factor_invalid",
  "rate_invalid",
  "reserve_invalid",
  "start_credit_invalid",
  "low_balance_invalid",
  "hourly_limit_invalid",
] as const;
export type BillingRateErrorCode = (typeof BILLING_RATE_ERROR_CODES)[number];

/** Billing cannot be switched on before A, both B and the Diff AI reserve are set (enforced where the switch is, #504). */
export const BILLING_RATES_INCOMPLETE = "billing_rates_incomplete" as const;

/** What the pricing engine needs: complete and valid. */
export type BillingRates = {
  /** Parts per 10,000. */
  factorA: number;
  /** Micro-USD per started minute, by review kind. */
  minuteRateMicroUsd: Record<ProjectReviewKind, number>;
  /** Micro-USD of real model cost, before A (see `DIFF_AI_RESERVE_MAX_MICRO_USD`). */
  diffAiReserveMicroUsd: number;
};

/** What is stored: each field only when it is set and valid. */
export type StoredBillingRates = {
  factorA?: number;
  minuteRateMicroUsd?: Partial<Record<ProjectReviewKind, number>>;
  diffAiReserveMicroUsd?: number;
  /** Micro-USD granted to a new workspace; 0 disables the grant. Not stored: the default (`billingNumbersOf`). */
  startCreditMicroUsd?: number;
  /** Micro-USD below which a balance is low. */
  lowBalanceMicroUsd?: number;
  /** Started reviews of a workspace in a rolling hour that the hidden abuse brake lets through. */
  hourlyReviewLimit?: number;
};

export type RatesPatchResult =
  | { ok: true; value: StoredBillingRates }
  | { ok: false; code: BillingRateErrorCode; field: string };

function isWholeNumberIn(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

export const isFactorA = (value: unknown): value is number =>
  isWholeNumberIn(value, FACTOR_A_MIN, FACTOR_A_MAX);
export const isMinuteRate = (value: unknown): value is number =>
  isWholeNumberIn(value, 0, MINUTE_RATE_MAX_MICRO_USD);
export const isDiffAiReserve = (value: unknown): value is number =>
  isWholeNumberIn(value, 0, DIFF_AI_RESERVE_MAX_MICRO_USD);
export const isStartCredit = (value: unknown): value is number =>
  isWholeNumberIn(value, 0, START_CREDIT_MAX_MICRO_USD);
export const isLowBalance = (value: unknown): value is number =>
  isWholeNumberIn(value, 0, LOW_BALANCE_MAX_MICRO_USD);
export const isHourlyReviewLimit = (value: unknown): value is number =>
  isWholeNumberIn(value, HOURLY_REVIEW_LIMIT_MIN, HOURLY_REVIEW_LIMIT_MAX);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KINDS: readonly ProjectReviewKind[] = ["diff", "dynamic"];

/**
 * Checks a change of the rates. It carries only the fields it states; a field it does not know is ignored (the switch is
 * not among them). One wrong field refuses the whole change.
 */
export function validateRatesPatch(input: unknown): RatesPatchResult {
  // The three codes are the whole vocabulary of the form; a body that is no object is a wrong factor, the first field.
  if (!isRecord(input))
    return { ok: false, code: "factor_invalid", field: "rates" };
  const value: StoredBillingRates = {};
  if ("factorA" in input) {
    if (!isFactorA(input.factorA))
      return { ok: false, code: "factor_invalid", field: "factorA" };
    value.factorA = input.factorA;
  }
  if ("minuteRateMicroUsd" in input) {
    const group = input.minuteRateMicroUsd;
    if (!isRecord(group))
      return { ok: false, code: "rate_invalid", field: "minuteRateMicroUsd" };
    const rates: Partial<Record<ProjectReviewKind, number>> = {};
    for (const kind of KINDS) {
      if (!(kind in group)) continue;
      const rate = group[kind];
      if (!isMinuteRate(rate))
        return {
          ok: false,
          code: "rate_invalid",
          field: `minuteRateMicroUsd.${kind}`,
        };
      rates[kind] = rate;
    }
    value.minuteRateMicroUsd = rates;
  }
  if ("diffAiReserveMicroUsd" in input) {
    if (!isDiffAiReserve(input.diffAiReserveMicroUsd))
      return {
        ok: false,
        code: "reserve_invalid",
        field: "diffAiReserveMicroUsd",
      };
    value.diffAiReserveMicroUsd = input.diffAiReserveMicroUsd;
  }
  if ("startCreditMicroUsd" in input) {
    if (!isStartCredit(input.startCreditMicroUsd))
      return {
        ok: false,
        code: "start_credit_invalid",
        field: "startCreditMicroUsd",
      };
    value.startCreditMicroUsd = input.startCreditMicroUsd;
  }
  if ("lowBalanceMicroUsd" in input) {
    if (!isLowBalance(input.lowBalanceMicroUsd))
      return {
        ok: false,
        code: "low_balance_invalid",
        field: "lowBalanceMicroUsd",
      };
    value.lowBalanceMicroUsd = input.lowBalanceMicroUsd;
  }
  if ("hourlyReviewLimit" in input) {
    if (!isHourlyReviewLimit(input.hourlyReviewLimit))
      return {
        ok: false,
        code: "hourly_limit_invalid",
        field: "hourlyReviewLimit",
      };
    value.hourlyReviewLimit = input.hourlyReviewLimit;
  }
  return { ok: true, value };
}

/** The numbers next to the rates as they are in force: the stored value, or the default where there is one. */
export type BillingNumbers = {
  startCreditMicroUsd: number;
  lowBalanceMicroUsd: number;
  hourlyReviewLimit: number;
};

export function billingNumbersOf(stored: StoredBillingRates): BillingNumbers {
  return {
    startCreditMicroUsd:
      stored.startCreditMicroUsd ?? DEFAULT_START_CREDIT_MICRO_USD,
    lowBalanceMicroUsd:
      stored.lowBalanceMicroUsd ?? DEFAULT_LOW_BALANCE_MICRO_USD,
    hourlyReviewLimit: stored.hourlyReviewLimit ?? DEFAULT_HOURLY_REVIEW_LIMIT,
  };
}

/**
 * The complete rates of a stored set, or null when A, a B or the Diff AI reserve is missing (a damaged field was dropped
 * on reading, so it is missing too). None of them has a default.
 */
export function billingRatesOf(
  stored: StoredBillingRates,
): BillingRates | null {
  const { factorA, minuteRateMicroUsd, diffAiReserveMicroUsd } = stored;
  const diff = minuteRateMicroUsd?.diff;
  const dynamic = minuteRateMicroUsd?.dynamic;
  if (
    factorA === undefined ||
    diff === undefined ||
    dynamic === undefined ||
    diffAiReserveMicroUsd === undefined
  )
    return null;
  return {
    factorA,
    minuteRateMicroUsd: { diff, dynamic },
    diffAiReserveMicroUsd,
  };
}

export type SwitchOnCheck =
  { ok: true } | { ok: false; code: typeof BILLING_RATES_INCOMPLETE };

/**
 * Whether billing may be switched on: only with A, both B and the Diff AI reserve set. The one question #504 asks where
 * the switch is, inside the same transaction under `lockBillingSettings` that writes `enabled`.
 */
export function canSwitchBillingOn(stored: StoredBillingRates): SwitchOnCheck {
  return billingRatesOf(stored) === null
    ? { ok: false, code: BILLING_RATES_INCOMPLETE }
    : { ok: true };
}
