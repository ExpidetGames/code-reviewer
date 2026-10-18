// SPDX-License-Identifier: Apache-2.0

// `price.created` and `price.updated` (#441, ADR 0005, 2.11 and 3): a price that a plan links is refreshed from the event, so a price
// archived or edited by hand in Paddle shows as drift in the plans view without anybody clicking "Refresh from Paddle". The app never
// writes to Paddle for it. The cache reflects Paddle as of the event, and an event older than the cache is stale. A price no plan
// links is not ours and is recorded as such. Reads nothing from outside; no outbound call.
import "server-only";
import { createBillingPlanPricesRepository } from "../db/repositories/billing-plan-prices-repository.ts";
import { paddlePriceSchema } from "./paddle-schemas.ts";
import { snapshotOf } from "./price-rules.ts";
import type { WebhookOutcome } from "./subscription-state.ts";
import type { ApplyContext } from "./webhook-context.ts";

export async function applyPriceEvent(
  context: ApplyContext,
): Promise<WebhookOutcome> {
  const parsed = paddlePriceSchema.safeParse(context.data);
  if (!parsed.success) return "payload_invalid";
  const prices = createBillingPlanPricesRepository(context.db, context.now);
  const row = await prices.getByPaddleId(parsed.data.id);
  // A price of the other environment is not the one this instance sells.
  if (row === undefined || row.env !== context.env) return "price_not_tracked";
  const refreshed = await prices.refreshIfNotNewer(
    row.id,
    snapshotOf(parsed.data),
    new Date(context.occurredAt),
  );
  return refreshed === undefined ? "stale_ignored" : "applied";
}
