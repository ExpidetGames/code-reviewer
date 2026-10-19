// SPDX-License-Identifier: Apache-2.0

// The rates of billing (ADR 0006, 2.4 and D2/D3): the factor A of the operator's key, the rate B per started minute for
// each review kind, and the AI reserve of a Diff review. Pure: the bounds, the validation with its stable codes, and
// the question whether a stored set is complete. Every amount is a whole number (no floating point is stored or read).
// No rate has a default in code: A and both B are admin data (D3); only the reserve, a hold and not a price, has one.
import "server-only";
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/** A is stored in parts per 10,000: 1.2 is 12,000. */
export const FACTOR_A_SCALE = 10_000;
export const FACTOR_A_MIN = 10_000;
export const FACTOR_A_MAX = 1_000_000;
/** The largest B: ten US dollars per started minute is far above any VM. */
export const MINUTE_RATE_MAX_MICRO_USD = 10_000_000;
/** The largest AI reserve of a Diff review: fifty US dollars. */
export const DIFF_AI_RESERVE_MAX_MICRO_USD = 50_000_000;
/**
 * The AI reserve of a Diff review while the admin has not set one: a Diff review has no enforced cost cap, so the hold
 * needs some AI part. A hold is not a price: settlement charges what the run really cost.
 */
export const DEFAULT_DIFF_AI_RESERVE_MICRO_USD = 500_000;

/** Stable codes of a refused rate; the admin form translates them to copy (#504). */
export const BILLING_RATE_ERROR_CODES = [
  "factor_invalid",
  "rate_invalid",
  "reserve_invalid",
] as const;
export type BillingRateErrorCode = (typeof BILLING_RATE_ERROR_CODES)[number];

/** Billing cannot be switched on before A and both B are set (enforced where the switch is, #504). */
export const BILLING_RATES_INCOMPLETE = "billing_rates_incomplete" as const;

/** What the pricing engine needs: complete and valid. */
export type BillingRates = {
  /** Parts per 10,000. */
  factorA: number;
  /** Micro-USD per started minute, by review kind. */
  minuteRateMicroUsd: Record<ProjectReviewKind, number>;
  diffAiReserveMicroUsd: number;
};

/** What is stored: each field only when it is set and valid. */
export type StoredBillingRates = {
  factorA?: number;
  minuteRateMicroUsd?: Partial<Record<ProjectReviewKind, number>>;
  diffAiReserveMicroUsd?: number;
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
  return { ok: true, value };
}

/**
 * The complete rates of a stored set, or null when A or a B is missing (a damaged field was dropped on reading, so it is
 * missing too). A and B have no default; the reserve takes its default.
 */
export function billingRatesOf(
  stored: StoredBillingRates,
): BillingRates | null {
  const { factorA, minuteRateMicroUsd } = stored;
  const diff = minuteRateMicroUsd?.diff;
  const dynamic = minuteRateMicroUsd?.dynamic;
  if (factorA === undefined || diff === undefined || dynamic === undefined)
    return null;
  return {
    factorA,
    minuteRateMicroUsd: { diff, dynamic },
    diffAiReserveMicroUsd:
      stored.diffAiReserveMicroUsd ?? DEFAULT_DIFF_AI_RESERVE_MICRO_USD,
  };
}

export type SwitchOnCheck =
  { ok: true } | { ok: false; code: typeof BILLING_RATES_INCOMPLETE };

/** Whether billing may be switched on: only with A and both B set. The one question #504 asks where the switch is. */
export function canSwitchBillingOn(stored: StoredBillingRates): SwitchOnCheck {
  return billingRatesOf(stored) === null
    ? { ok: false, code: BILLING_RATES_INCOMPLETE }
    : { ok: true };
}
