// SPDX-License-Identifier: Apache-2.0

// What the plans page shows of the Paddle prices linked to a version (#439): the cached price next to the amount the
// operator entered, the drift when the two no longer fit, and whether the version can be sold. Pure over rows already read.
import "server-only";
import type { PriceLinkView } from "../admin/ui/plans-view.ts";
import type {
  PaddleEnv,
  PriceRow,
} from "../db/repositories/billing-plan-prices-repository.ts";
import type { PlanVersionRow } from "../db/repositories/billing-plan-versions-repository.ts";
import {
  checkPrice,
  type PriceExpectation,
  type PriceFacts,
} from "./price-rules.ts";

/** The cached price as the rules read it. A price that is not recurring any more is cached with an empty interval. */
export function factsOfRow(row: PriceRow): PriceFacts {
  return {
    status: row.status,
    recurring: row.interval !== "",
    interval: row.interval,
    frequency: row.frequency,
    currency: row.currency,
    taxMode: row.taxMode,
    amount: row.amount,
    hasOverrides: row.hasOverrides,
    quantityMinimum: row.quantityMinimum,
    quantityMaximum: row.quantityMaximum,
    productId: row.productId,
  };
}

/** A price linked to a slot: the cache, and the first rule it breaks now (`drift`), if any. */
export function priceLinkView(
  row: PriceRow,
  expected: PriceExpectation,
  configured: PaddleEnv,
): PriceLinkView {
  const mismatch =
    row.env === configured
      ? checkPrice(factsOfRow(row), expected)
      : { code: "price_environment_mismatch" as const };
  return {
    paddlePriceId: row.paddlePriceId ?? "",
    interval: row.interval,
    frequency: row.frequency,
    currency: row.currency,
    taxMode: row.taxMode,
    amount: row.amount,
    status: row.status,
    trialDays: row.trialDays,
    snapshotAt: row.snapshotAt,
    drift: mismatch?.code ?? null,
    ...(mismatch !== undefined &&
    "entered" in mismatch &&
    mismatch.entered !== undefined
      ? { driftEntered: mismatch.entered }
      : {}),
    ...(mismatch !== undefined &&
    "paddle" in mismatch &&
    mismatch.paddle !== undefined
      ? { driftPaddle: mismatch.paddle }
      : {}),
  };
}

export type VersionPrices = {
  monthlyPrice: PriceLinkView | null;
  yearlyPrice: PriceLinkView | null;
  sellable: boolean;
};

/**
 * The linked prices of a version and whether it can be sold: every slot the version has an entered amount for is linked to
 * a price that is exactly that price now. A version without a yearly amount has no yearly slot and needs no yearly price.
 */
export function versionPrices(
  version: PlanVersionRow,
  prices: ReadonlyMap<string, PriceRow>,
  productId: string | null,
  configured: PaddleEnv,
): VersionPrices {
  function slot(
    interval: "month" | "year",
    amountMinor: number | null,
    priceId: string | null,
  ): PriceLinkView | null {
    if (amountMinor === null || priceId === null) return null;
    const row = prices.get(priceId);
    if (row === undefined) return null;
    return priceLinkView(row, { interval, amountMinor, productId }, configured);
  }
  const monthlyPrice = slot(
    "month",
    version.monthlyAmountMinor,
    version.monthlyPriceId,
  );
  const yearlyPrice = slot(
    "year",
    version.yearlyAmountMinor,
    version.yearlyPriceId,
  );
  const sellable =
    version.monthlyAmountMinor !== null &&
    monthlyPrice !== null &&
    monthlyPrice.drift === null &&
    (version.yearlyAmountMinor === null ||
      (yearlyPrice !== null && yearlyPrice.drift === null));
  return { monthlyPrice, yearlyPrice, sellable };
}
