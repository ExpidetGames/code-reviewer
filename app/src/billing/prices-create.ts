// SPDX-License-Identifier: Apache-2.0

// Creating the Paddle prices of a plan version (#440, ADR 0005, 2.11, decision M5): the operator presses "Create prices" and the
// app makes, for the current version, the Paddle product on first use and a new price for each amount the operator entered
// (#438): a monthly one and, only when a yearly amount is entered, a yearly one. The amount, the currency, the tax mode and the
// interval come from the version and from `price-create-rules.ts`, never from the request. A price is only ever created: the
// app never edits an amount (decision M6: a changed amount is a new version with new prices).
//
// Paddle has no idempotency keys, so a create that is answered with silence may have happened. Therefore:
// - An intent row (`billing_plan_prices`, `state: pending`) is written before Paddle is asked. Its name is the same for the
//   same version, slot and trial, so a second click, a second admin and a retry all meet one row; a row that is being worked
//   on is not worked on twice, and one that died (`attempted_at` is old) is taken over by one request only.
// - After a create that ended without a clear answer (timeout, reset, 5xx, an unreadable answer) and before any further
//   create, the product's prices are listed and the one that carries the intent is taken. A row that is `failed` or taken over
//   is reconciled the same way first. The price is found by its custom data (`cr_intent`), which Paddle echoes.
// - The price is recorded on its row the moment it is known, in a write of its own, and linked afterwards through the same
//   judgment and compare-and-set as a price the operator links (`price-link.ts`). When the link is refused (the plan was
//   saved again, another admin linked a price) the price is NOT archived: it stays recorded as `ready` and linked to no
//   version, the plans page lists it as an attempt, and the operator archives it there if no version needs it. An automatic
//   archive would be a second write to Paddle that can fail the same way, and whether an archived price can be brought back
//   is not known (research S2).
// The webhook `price.created` will adopt a price whose intent matches (#441); the list-and-match here is the base path.
import "server-only";
import {
  PriceTakenError,
  type PaddleEnv,
  type PriceRow,
} from "../db/repositories/billing-plan-prices-repository.ts";
import type { PlanRow } from "../db/repositories/billing-plans-repository.ts";
import {
  PaddleClientError,
  type PaddleClient,
  type PaddlePage,
  type PaddlePrice,
} from "./paddle-client.ts";
import {
  amountToCreate,
  intentIdOf,
  matchesIntent,
  matchesProductIntent,
  priceRequestOf,
  productRequestOf,
  trialDaysToCreate,
} from "./price-create-rules.ts";
import type { PriceRefusal } from "./price-errors.ts";
import {
  linkPrice,
  repositoriesOf,
  snapshotOf,
  type PricesResult,
} from "./price-link.ts";
import {
  PRICE_CURRENCY,
  PRICE_TAX_MODE,
  checkPrice,
  factsOf,
  type PriceInterval,
} from "./price-rules.ts";
import type { PricesCore } from "./prices-core.ts";

/** Creates tried for one price or product: the first, and two after a look at Paddle. */
export const MAX_CREATE_ATTEMPTS = 3;
/** An attempt older than this has died: a request ends well before (10 s a call, a few calls). */
export const ATTEMPT_STALE_MS = 10 * 60_000;
/** The most pages a list is followed for; a longer list is refused, not cut, because a price on a page not seen would be made twice. */
const MAX_LIST_PAGES = 20;
const CREATE_KEYS = ["versionNumber", "trialDays"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Paddle said no and will say it again: the request is wrong. Every other failure leaves it open whether the create ran. */
const REFUSED_BY_PADDLE = new Set([
  "bad_request",
  "rejected",
  "conflict",
  "not_found",
  "invalid_argument",
]);
const UNKNOWN_OUTCOME = new Set([
  "timeout",
  "network_error",
  "server_error",
  "invalid_response",
  "rate_limited",
]);

async function listAll<T>(
  read: (after: string | undefined) => Promise<PaddlePage<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < MAX_LIST_PAGES; pages += 1) {
    const page = await read(after);
    all.push(...page.items);
    if (page.nextAfter === null) return all;
    after = page.nextAfter;
  }
  throw new PaddleClientError("invalid_response", {
    context: "a list too long to read",
  });
}

type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: PriceRefusal };

/** What the slot of a version needs: the amount entered, and the link it holds. */
type Slot = {
  interval: PriceInterval;
  entered: number;
  amount: string;
  linked: string | null;
};

function withSlot(
  refusal: PriceRefusal,
  interval: PriceInterval,
): PriceRefusal {
  if (refusal.code === "plan_changed") return refusal;
  if (refusal.field === undefined || refusal.field === "paddlePriceId")
    return { ...refusal, field: interval };
  return refusal;
}

export function createPriceCreator(core: PricesCore) {
  const { db, now } = core;

  function createRefusal(error: PaddleClientError): PriceRefusal {
    return REFUSED_BY_PADDLE.has(error.code)
      ? { code: "price_create_rejected" }
      : core.paddleRefusal(error);
  }

  /**
   * Runs a create, and after an answer that leaves it open whether it ran, looks for what it would have made before it tries
   * again, up to `MAX_CREATE_ATTEMPTS` creates. If Paddle cannot be asked what exists, it does not create blind.
   */
  async function reconciled<T>(
    attempt: () => Promise<T>,
    find: () => Promise<T | undefined>,
  ): Promise<Outcome<T>> {
    let last: PriceRefusal = { code: "paddle_unavailable" };
    for (let tries = 0; tries < MAX_CREATE_ATTEMPTS; tries += 1) {
      try {
        return { ok: true, value: await attempt() };
      } catch (error) {
        if (!(error instanceof PaddleClientError)) throw error;
        last = createRefusal(error);
        if (!UNKNOWN_OUTCOME.has(error.code))
          return { ok: false, refusal: last };
      }
      try {
        const found = await find();
        if (found !== undefined) return { ok: true, value: found };
      } catch (error) {
        if (!(error instanceof PaddleClientError)) throw error;
        return { ok: false, refusal: core.paddleRefusal(error) };
      }
    }
    return { ok: false, refusal: last };
  }

  /** The product of the plan: the one it is bound to, one an earlier attempt made, or a new one; bound to the plan. */
  async function ensureProduct(
    plan: PlanRow,
    env: PaddleEnv,
    client: PaddleClient,
  ): Promise<Outcome<PlanRow>> {
    if (plan.paddleProductId !== null) return { ok: true, value: plan };
    const find = async () =>
      (
        await listAll((after) =>
          client.listProducts({
            status: ["active"],
            per_page: 200,
            ...(after === undefined ? {} : { after }),
          }),
        )
      ).find((product) => matchesProductIntent(product, plan.id, plan.planKey));
    let product;
    try {
      product = await find();
    } catch (error) {
      if (!(error instanceof PaddleClientError)) throw error;
      return { ok: false, refusal: core.paddleRefusal(error) };
    }
    if (product === undefined) {
      const created = await reconciled(
        () =>
          client.createProduct(
            productRequestOf({
              planKey: plan.planKey,
              planId: plan.id,
              name: plan.name,
            }),
          ),
        find,
      );
      if (!created.ok) return created;
      product = created.value;
    }
    // Of two requests that make a product at once the first bind wins; the other's product stays unused at Paddle (empty,
    // harmless) and no price is made on it, because the prices go on the bound product.
    const bound = await repositoriesOf(db, now).plans.bindProduct(
      plan.id,
      product.id,
      env,
    );
    if (bound.env !== env)
      return { ok: false, refusal: { code: "price_environment_mismatch" } };
    return {
      ok: true,
      value: {
        ...plan,
        paddleProductId: bound.productId,
        paddleProductEnv: bound.env,
      },
    };
  }

  /** The active price of a product that carries the intent, if Paddle has one. */
  function findPrice(
    client: PaddleClient,
    productId: string,
    intentId: string,
    planKey: string,
  ): Promise<PaddlePrice | undefined> {
    return listAll((after) =>
      client.listPrices({
        product_id: [productId],
        status: ["active"],
        per_page: 200,
        ...(after === undefined ? {} : { after }),
      }),
    ).then((prices) =>
      prices.find((price) => matchesIntent(price, intentId, planKey)),
    );
  }

  type SlotContext = {
    plan: PlanRow;
    versionId: string;
    versionNumber: number;
    trialDays: number | null;
    env: PaddleEnv;
    client: PaddleClient;
  };

  /**
   * The intent row of a slot and whether this request may work on it. A new row is this request's. An old row is taken over
   * if it failed, or if it is pending and its attempt is old (one request wins the take-over); a pending row with a recent
   * attempt is somebody's work in progress.
   */
  async function claimRow(
    context: SlotContext,
    slot: Slot,
  ): Promise<Outcome<{ row: PriceRow; fresh: boolean }>> {
    const prices = repositoriesOf(db, now).prices;
    const productId = context.plan.paddleProductId;
    if (productId === null) throw new Error("The plan has no Paddle product.");
    const { row, created } = await prices.insertPending({
      planId: context.plan.id,
      intentId: intentIdOf({
        versionId: context.versionId,
        interval: slot.interval,
        trialDays: context.trialDays,
      }),
      env: context.env,
      productId,
      interval: slot.interval,
      amount: slot.amount,
      currency: PRICE_CURRENCY,
      taxMode: PRICE_TAX_MODE,
      quantityMinimum: 1,
      quantityMaximum: 1,
      trialDays: context.trialDays,
    });
    if (created) return { ok: true, value: { row, fresh: true } };
    // A price that exists at Paddle is judged and linked, whatever state its row is in.
    if (row.paddlePriceId !== null)
      return { ok: true, value: { row, fresh: false } };
    const abandoned =
      row.state === "pending" &&
      (row.attemptedAt === null ||
        now().getTime() - Date.parse(row.attemptedAt) > ATTEMPT_STALE_MS);
    if (row.state === "pending" && !abandoned)
      return { ok: false, refusal: { code: "price_creation_pending" } };
    const taken = await prices.startAttempt(row.id, {
      state: row.state === "failed" ? "failed" : "pending",
      attemptedAt: row.attemptedAt,
    });
    if (!taken)
      return { ok: false, refusal: { code: "price_creation_pending" } };
    return { ok: true, value: { row, fresh: false } };
  }

  async function createSlot(
    context: SlotContext,
    slot: Slot,
  ): Promise<PricesResult> {
    const { plan, client, env } = context;
    const prices = repositoriesOf(db, now).prices;
    const claimed = await claimRow(context, slot);
    if (!claimed.ok) return { ok: false, ...claimed.refusal };
    const { row, fresh } = claimed.value;

    let price: PaddlePrice;
    if (row.paddlePriceId !== null) {
      // The price exists: read it as it is now.
      try {
        price = await client.getPrice(row.paddlePriceId);
      } catch (error) {
        if (!(error instanceof PaddleClientError)) throw error;
        return { ok: false, ...core.paddleRefusal(error) };
      }
    } else {
      const intentId = row.intentId ?? "";
      const find = () =>
        findPrice(client, row.productId, intentId, plan.planKey);
      let earlier: PaddlePrice | undefined;
      if (!fresh) {
        // The earlier attempt may have got as far as Paddle: look before creating.
        try {
          earlier = await find();
        } catch (error) {
          if (!(error instanceof PaddleClientError)) throw error;
          const refusal = core.paddleRefusal(error);
          await prices.markFailed(row.id, refusal.code);
          return { ok: false, ...refusal };
        }
      }
      if (earlier !== undefined) price = earlier;
      else {
        const made = await reconciled(
          () =>
            client.createPrice(
              priceRequestOf({
                planKey: plan.planKey,
                intentId,
                productId: row.productId,
                interval: slot.interval,
                amount: slot.amount,
                trialDays: context.trialDays,
              }),
            ),
          find,
        );
        if (!made.ok) {
          await prices.markFailed(row.id, made.refusal.code);
          return { ok: false, ...made.refusal };
        }
        price = made.value;
      }
    }

    // Recorded before it is linked, in a write of its own: whatever happens to the link, the price is not forgotten.
    const mismatch = checkPrice(factsOf(price), {
      interval: slot.interval,
      amountMinor: slot.entered,
      productId: plan.paddleProductId,
    });
    try {
      await prices.recordCreated(
        row.id,
        price.id,
        snapshotOf(price),
        mismatch === undefined
          ? { state: "ready" }
          : { state: "failed", code: mismatch.code },
      );
    } catch (error) {
      if (error instanceof PriceTakenError)
        return {
          ok: false,
          code: "price_used_by_other_plan",
          field: slot.interval,
        };
      throw error;
    }
    if (mismatch !== undefined)
      return { ok: false, ...mismatch, field: slot.interval };
    const linked = await linkPrice(core, {
      plan,
      versionNumber: context.versionNumber,
      interval: slot.interval,
      expectedLink: slot.linked,
      entered: slot.entered,
      env,
      paddlePriceId: price.id,
      price,
    });
    return linked.ok
      ? linked
      : { ok: false, ...withSlot(linked, slot.interval) };
  }

  return async function create(
    planKey: string,
    input: unknown,
  ): Promise<PricesResult> {
    const body = isRecord(input) ? input : undefined;
    const versionNumber = body?.versionNumber;
    if (
      body === undefined ||
      Object.keys(body).some((key) => !CREATE_KEYS.includes(key)) ||
      typeof versionNumber !== "number" ||
      !Number.isSafeInteger(versionNumber) ||
      versionNumber < 1
    )
      return { ok: false, code: "price_input_invalid" };
    const trial = trialDaysToCreate(body.trialDays);
    if (!trial.ok)
      return { ok: false, code: "price_trial_invalid", field: "trialDays" };

    const { plans, versions } = repositoriesOf(db, now);
    const plan = await plans.get(planKey);
    if (plan === undefined) return { ok: false, code: "plan_not_found" };
    if (plan.kind !== "paid") return { ok: false, code: "price_plan_not_paid" };
    if (plan.archivedAt !== null) return { ok: false, code: "plan_archived" };
    const current = await versions.current(plan.id);
    if (current === undefined || current.number !== versionNumber)
      return { ok: false, code: "plan_changed" };

    // The slots the version has an amount for, each checked before anything is sent: the form takes no amount, so this
    // guards the stored data.
    const slots: Slot[] = [];
    for (const [interval, entered, linked] of [
      ["month", current.monthlyAmountMinor, current.monthlyPriceId],
      ["year", current.yearlyAmountMinor, current.yearlyPriceId],
    ] as const) {
      if (entered === null) continue;
      const amount = amountToCreate(entered);
      if (!amount.ok)
        return { ok: false, code: "price_amount_invalid", field: interval };
      slots.push({ interval, entered, amount: amount.amount, linked });
    }
    const missing = slots.filter((slot) => slot.linked === null);
    if (missing.length === 0) return { ok: true };

    const env = await core.configuredEnvironment();
    if (plan.paddleProductEnv !== null && plan.paddleProductEnv !== env)
      return { ok: false, code: "price_environment_mismatch" };
    const made = await core.storedClient(env);
    if (!made.ok) return { ok: false, ...made.refusal };
    const product = await ensureProduct(plan, env, made.client);
    if (!product.ok) return { ok: false, ...product.refusal };

    for (const slot of missing) {
      const result = await createSlot(
        {
          plan: product.value,
          versionId: current.id,
          versionNumber,
          trialDays: trial.days,
          env,
          client: made.client,
        },
        slot,
      );
      // The next slot is not tried after a failure: whatever stopped this one will stop that one, and a retry goes on from here.
      if (!result.ok) return { ok: false, ...withSlot(result, slot.interval) };
    }
    return { ok: true };
  };
}
