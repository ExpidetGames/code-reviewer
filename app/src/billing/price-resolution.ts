// SPDX-License-Identifier: Apache-2.0

// Which plan version a subscription's Paddle price belongs to (#441, ADR 0005, 2.12): the only place the webhook turns a price
// into a version. A price is a `billing_plan_prices` row of this environment that a version links in its monthly or yearly slot.
// - A new subscription (`strict`): the price must be a slot of the version the checkout row names, in the interval the checkout bought.
//   Nothing else sells it, however the payload reads.
// - A later event: the price of the pinned version, or else the current version of exactly one plan that sells with it (a plan
//   change moves the pin). Anything else is unmapped and the state is kept.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import {
  createBillingPlanPricesRepository,
  type PaddleEnv,
} from "../db/repositories/billing-plan-prices-repository.ts";
import {
  createBillingPlanVersionsRepository,
  type PlanVersionRow,
} from "../db/repositories/billing-plan-versions-repository.ts";
import type { BillingInterval } from "./subscription-state.ts";

export type ResolvedVersion = {
  versionId: string;
  interval: BillingInterval;
};

function slotOf(
  version: PlanVersionRow,
  priceRowId: string,
): BillingInterval | undefined {
  if (version.monthlyPriceId === priceRowId) return "month";
  if (version.yearlyPriceId === priceRowId) return "year";
  return undefined;
}

export async function resolveVersionForPrice(
  db: Kysely<Database>,
  env: PaddleEnv,
  paddlePriceId: string,
  pinnedVersionId: string,
  options: { strict: boolean; interval?: BillingInterval },
): Promise<ResolvedVersion | undefined> {
  const price =
    await createBillingPlanPricesRepository(db).getByPaddleId(paddlePriceId);
  if (price === undefined || price.env !== env) return undefined;
  const versions = createBillingPlanVersionsRepository(db);
  const pinned = await versions.get(pinnedVersionId);
  const pinnedSlot =
    pinned === undefined ? undefined : slotOf(pinned, price.id);
  if (pinned !== undefined && pinnedSlot !== undefined)
    return options.interval !== undefined && options.interval !== pinnedSlot
      ? undefined
      : { versionId: pinned.id, interval: pinnedSlot };
  if (options.strict) return undefined;

  const candidates = await versions.currentLinkedTo(price.id);
  const plans = new Set(candidates.map((version) => version.planId));
  const [only] = candidates;
  if (plans.size !== 1 || only === undefined) return undefined;
  const interval = slotOf(only, price.id);
  return interval === undefined ? undefined : { versionId: only.id, interval };
}
