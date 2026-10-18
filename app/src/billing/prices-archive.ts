// SPDX-License-Identifier: Apache-2.0

// Archiving a Paddle price (#440, ADR 0005, 2.11): the only change the app makes to a price once it exists, and a change of its
// status alone, never of an amount. A price is archived only when the current version of its plan is not sold with it and no
// live subscription at Paddle uses it (whether a subscription keeps renewing on an archived price is not known, research S2).
// A price is never deleted. Billing off: this service is not reached (the routes answer the missing path).
import "server-only";
import { PaddleClientError } from "./paddle-client.ts";
import type { PricesResult } from "./price-link.ts";
import { repositoriesOf } from "./price-link.ts";
import type { PricesCore } from "./prices-core.ts";

const PRICE_ID = /^pri_[A-Za-z0-9]{1,60}$/;
const ARCHIVE_KEYS = ["paddlePriceId"];
/** Every state of a subscription in which it can still be billed. */
const LIVE_STATES = ["active", "trialing", "past_due", "paused"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPriceArchiver(core: PricesCore) {
  const { db, now } = core;
  return async function archive(
    planKey: string,
    input: unknown,
  ): Promise<PricesResult> {
    const body = isRecord(input) ? input : undefined;
    if (
      body === undefined ||
      Object.keys(body).some((key) => !ARCHIVE_KEYS.includes(key))
    )
      return { ok: false, code: "price_input_invalid" };
    const paddlePriceId = body.paddlePriceId;
    if (typeof paddlePriceId !== "string" || !PRICE_ID.test(paddlePriceId))
      return { ok: false, code: "price_id_invalid", field: "paddlePriceId" };

    const { plans, versions, prices } = repositoriesOf(db, now);
    const plan = await plans.get(planKey);
    if (plan === undefined) return { ok: false, code: "plan_not_found" };
    if (plan.kind !== "paid") return { ok: false, code: "price_plan_not_paid" };
    const row = await prices.getByPaddleId(paddlePriceId);
    if (row === undefined || row.planId !== plan.id)
      return { ok: false, code: "price_not_found", field: "paddlePriceId" };
    if (row.archivedAt !== null) return { ok: true };
    const current = await versions.current(plan.id);
    if (
      current !== undefined &&
      (current.monthlyPriceId === row.id || current.yearlyPriceId === row.id)
    )
      return { ok: false, code: "price_in_use", field: "paddlePriceId" };
    const env = await core.configuredEnvironment();
    if (row.env !== env)
      return { ok: false, code: "price_environment_mismatch" };

    const made = await core.storedClient(env);
    if (!made.ok) return { ok: false, ...made.refusal };
    try {
      const using = await made.client.listSubscriptions({
        price_id: [paddlePriceId],
        status: [...LIVE_STATES],
        per_page: 1,
      });
      if (using.items.length > 0)
        return {
          ok: false,
          code: "price_has_subscribers",
          field: "paddlePriceId",
        };
      await made.client.updatePrice(paddlePriceId, { status: "archived" });
    } catch (error) {
      if (!(error instanceof PaddleClientError)) throw error;
      return { ok: false, ...core.paddleRefusal(error) };
    }
    await prices.markArchived(row.id);
    return { ok: true };
  };
}
