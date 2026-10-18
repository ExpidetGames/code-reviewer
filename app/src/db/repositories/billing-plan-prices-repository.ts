// SPDX-License-Identifier: Apache-2.0

// Access to the billing_plan_prices table: the Paddle prices the app knows (#439, ADR 0005, 2.11; src/billing/README.md).
// Instance level, like the plans: a price is configuration, not customer data. A row is the cache of what Paddle said about
// one price at `snapshot_at`; nothing here, and nothing above, writes that back to Paddle. A Paddle price is one row
// (unique `paddle_price_id`), belongs to one plan, and any number of versions may link to it.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { decodeBoolean, encodeBoolean, formatTimestamp } from "../codecs.ts";
import { errorCode } from "../errors.ts";
import type { BillingPlanPricesTable, Database } from "../schema.ts";

/** Thrown by `insertLinked` when a row has this Paddle price already (another request, or another plan, got there first). */
export class PriceTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super("This Paddle price is stored already.", options);
    this.name = "PriceTakenError";
  }
}

export type PaddleEnv = "sandbox" | "live";

/** What Paddle says about a price: the facts the app caches. The amount is Paddle's own string of minor units. */
export type PriceSnapshot = {
  productId: string;
  interval: string;
  frequency: number;
  currency: string;
  amount: string;
  taxMode: string;
  hasOverrides: boolean;
  trialDays: number | null;
  /** Paddle's limits for the quantity of one item. */
  quantityMinimum: number;
  quantityMaximum: number;
  status: string;
};

export type PriceRow = PriceSnapshot & {
  id: string;
  planId: string;
  paddlePriceId: string | null;
  env: PaddleEnv;
  origin: "linked" | "created";
  state: "pending" | "ready" | "failed";
  snapshotAt: string | null;
  createdAt: string;
};

export type NewLinkedPrice = {
  planId: string;
  paddlePriceId: string;
  env: PaddleEnv;
  snapshot: PriceSnapshot;
};

export type BillingPlanPricesRepository = {
  get(id: string): Promise<PriceRow | undefined>;
  getByPaddleId(paddlePriceId: string): Promise<PriceRow | undefined>;
  /** Every price of a plan, oldest first. */
  listForPlan(planId: string): Promise<PriceRow[]>;
  /** The rows with these ids, in no particular order. */
  listByIds(ids: readonly string[]): Promise<PriceRow[]>;
  /** Stores a price the operator linked. `PriceTakenError` when a row has the Paddle price already. */
  insertLinked(input: NewLinkedPrice): Promise<PriceRow>;
  /** Replaces what is cached with a new answer of Paddle and the time it was read; the identity of the row never changes. */
  refresh(id: string, snapshot: PriceSnapshot): Promise<PriceRow>;
};

type Row = Selectable<BillingPlanPricesTable>;

const MINOR_UNITS = /^[0-9]{1,30}$/;

function assertSnapshot(snapshot: PriceSnapshot): void {
  // The table cannot check digits on both engines, so the only writer does.
  if (!MINOR_UNITS.test(snapshot.amount))
    throw new Error("A cached amount is a string of minor units.");
  for (const limit of [snapshot.quantityMinimum, snapshot.quantityMaximum])
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("A cached quantity limit is a whole number from one.");
}

function toPrice(row: Row): PriceRow {
  const env = row.paddle_env === "live" ? "live" : "sandbox";
  const origin = row.origin === "created" ? "created" : "linked";
  const state =
    row.state === "pending" || row.state === "failed" ? row.state : "ready";
  return {
    id: row.id,
    planId: row.plan_id,
    paddlePriceId: row.paddle_price_id,
    productId: row.paddle_product_id,
    env,
    interval: row.interval,
    frequency: row.frequency,
    currency: row.currency,
    amount: row.unit_amount_minor,
    taxMode: row.tax_mode,
    hasOverrides: decodeBoolean(row.has_overrides),
    trialDays: row.trial_days,
    quantityMinimum: row.quantity_min,
    quantityMaximum: row.quantity_max,
    status: row.paddle_status ?? "",
    origin,
    state,
    snapshotAt: row.snapshot_at,
    createdAt: row.created_at,
  };
}

/** SQLite names the constraint kind, Postgres answers SQLSTATE 23505. */
function isUniqueViolation(cause: unknown): boolean {
  const code = errorCode(cause);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505";
}

export function createBillingPlanPricesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newId: () => string = () => `bpp_${randomUUID().replaceAll("-", "")}`,
): BillingPlanPricesRepository {
  async function byColumn(column: "id" | "paddle_price_id", value: string) {
    const row = await db
      .selectFrom("billing_plan_prices")
      .selectAll()
      .where(column, "=", value)
      .executeTakeFirst();
    return row === undefined ? undefined : toPrice(row);
  }

  return {
    get: (id) => byColumn("id", id),
    getByPaddleId: (paddlePriceId) =>
      byColumn("paddle_price_id", paddlePriceId),

    async listForPlan(planId) {
      const rows = await db
        .selectFrom("billing_plan_prices")
        .selectAll()
        .where("plan_id", "=", planId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toPrice);
    },

    async listByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .selectFrom("billing_plan_prices")
        .selectAll()
        .where("id", "in", [...ids])
        .execute();
      return rows.map(toPrice);
    },

    async insertLinked({ planId, paddlePriceId, env, snapshot }) {
      assertSnapshot(snapshot);
      const at = formatTimestamp(now());
      const id = newId();
      try {
        await db
          .insertInto("billing_plan_prices")
          .values({
            id,
            plan_id: planId,
            paddle_price_id: paddlePriceId,
            paddle_product_id: snapshot.productId,
            paddle_env: env,
            interval: snapshot.interval,
            frequency: snapshot.frequency,
            currency: snapshot.currency,
            unit_amount_minor: snapshot.amount,
            tax_mode: snapshot.taxMode,
            has_overrides: encodeBoolean(snapshot.hasOverrides),
            trial_days: snapshot.trialDays,
            quantity_min: snapshot.quantityMinimum,
            quantity_max: snapshot.quantityMaximum,
            paddle_status: snapshot.status,
            origin: "linked",
            intent_id: null,
            state: "ready",
            last_error_code: null,
            snapshot_at: at,
            created_at: at,
            archived_at: null,
          })
          .execute();
      } catch (cause) {
        if (isUniqueViolation(cause)) throw new PriceTakenError({ cause });
        throw cause;
      }
      const stored = await byColumn("id", id);
      if (stored === undefined) throw new Error("The price cannot be read.");
      return stored;
    },

    async refresh(id, snapshot) {
      assertSnapshot(snapshot);
      await db
        .updateTable("billing_plan_prices")
        .set({
          paddle_product_id: snapshot.productId,
          interval: snapshot.interval,
          frequency: snapshot.frequency,
          currency: snapshot.currency,
          unit_amount_minor: snapshot.amount,
          tax_mode: snapshot.taxMode,
          has_overrides: encodeBoolean(snapshot.hasOverrides),
          trial_days: snapshot.trialDays,
          quantity_min: snapshot.quantityMinimum,
          quantity_max: snapshot.quantityMaximum,
          paddle_status: snapshot.status,
          snapshot_at: formatTimestamp(now()),
        })
        .where("id", "=", id)
        .execute();
      const stored = await byColumn("id", id);
      if (stored === undefined) throw new Error("The price cannot be read.");
      return stored;
    },
  };
}
