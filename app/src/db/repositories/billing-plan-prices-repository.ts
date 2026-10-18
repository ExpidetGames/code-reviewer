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
  /** `standard` or `custom`. */
  priceType: string;
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
  /** The id the app gave the attempt to create this price (`origin: "created"`); null for a price the operator linked. */
  intentId: string | null;
  /** The stable code of the last failed attempt; null while the price is not failed. */
  lastErrorCode: string | null;
  /** When the app last started creating this price at Paddle; null for a linked price. */
  attemptedAt: string | null;
  snapshotAt: string | null;
  createdAt: string;
  /** When the operator archived the price through the app; null while it was not. */
  archivedAt: string | null;
};

export type NewLinkedPrice = {
  planId: string;
  paddlePriceId: string;
  env: PaddleEnv;
  snapshot: PriceSnapshot;
};

/** The intent row of a price the app creates (#440): what will be sent to Paddle, written before Paddle is asked. */
export type NewPendingPrice = {
  planId: string;
  /** Unique: the same request twice has the same intent, so it finds the row of the first. */
  intentId: string;
  env: PaddleEnv;
  productId: string;
  interval: "month" | "year";
  /** Minor units, a string like Paddle writes it. */
  amount: string;
  currency: string;
  taxMode: string;
  quantityMinimum: number;
  quantityMaximum: number;
  trialDays: number | null;
};

/** What Paddle's answer to a create amounted to: the price is the one asked for, or it breaks a rule (the code of the rule). */
export type CreatedOutcome =
  { state: "ready" } | { state: "failed"; code: string };

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

  /** The row of an attempt to create a price, by the intent it was written with. */
  getByIntent(intentId: string): Promise<PriceRow | undefined>;
  /**
   * Writes the intent row of a price the app is about to create: `pending`, with the values that will be sent. Of two
   * requests with one intent the second finds the row of the first (`created: false`) and writes nothing.
   */
  insertPending(
    input: NewPendingPrice,
  ): Promise<{ row: PriceRow; created: boolean }>;
  /**
   * Starts a new attempt on a row that is `failed`, or `pending` and abandoned: one conditional write against the state
   * and attempt time the caller read, so of two requests that take the row over only one gets `true`.
   */
  startAttempt(
    id: string,
    expected: { state: "pending" | "failed"; attemptedAt: string | null },
  ): Promise<boolean>;
  /** The attempt ended without a price: `failed` with a stable code, retried by the next request. */
  markFailed(id: string, code: string): Promise<void>;
  /**
   * Paddle created the price: stores its id (once) and what Paddle said, and the outcome. The same id again only refreshes the
   * row; a different id on a row that has one, or an id another row has, is refused (`PriceTakenError` for the latter).
   */
  recordCreated(
    id: string,
    paddlePriceId: string,
    snapshot: PriceSnapshot,
    outcome: CreatedOutcome,
  ): Promise<PriceRow>;
  /** The price was archived at Paddle through the app: the cache says so and the time is kept. */
  markArchived(id: string): Promise<void>;
  /** The prices of a plan that the app created and no version links, not archived: attempts to retry and orphans to archive. */
  listUnlinkedCreated(planId: string): Promise<PriceRow[]>;
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
    priceType: row.price_type,
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
    intentId: row.intent_id,
    lastErrorCode: row.last_error_code,
    attemptedAt: row.attempted_at,
    snapshotAt: row.snapshot_at,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
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
  async function byColumn(
    column: "id" | "paddle_price_id" | "intent_id",
    value: string,
  ) {
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
    getByIntent: (intentId) => byColumn("intent_id", intentId),

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
            price_type: snapshot.priceType,
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
          price_type: snapshot.priceType,
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

    async insertPending(input) {
      const at = formatTimestamp(now());
      const id = newId();
      try {
        await db
          .insertInto("billing_plan_prices")
          .values({
            id,
            plan_id: input.planId,
            paddle_price_id: null,
            paddle_product_id: input.productId,
            price_type: "standard",
            paddle_env: input.env,
            interval: input.interval,
            frequency: 1,
            currency: input.currency,
            unit_amount_minor: input.amount,
            tax_mode: input.taxMode,
            has_overrides: 0,
            trial_days: input.trialDays,
            quantity_min: input.quantityMinimum,
            quantity_max: input.quantityMaximum,
            paddle_status: null,
            origin: "created",
            intent_id: input.intentId,
            state: "pending",
            last_error_code: null,
            snapshot_at: null,
            created_at: at,
            archived_at: null,
            attempted_at: at,
          })
          .execute();
      } catch (cause) {
        if (!isUniqueViolation(cause)) throw cause;
        // The other request wrote the row first: this one works on that row.
        const first = await byColumn("intent_id", input.intentId);
        if (first === undefined) throw cause;
        return { row: first, created: false };
      }
      const stored = await byColumn("id", id);
      if (stored === undefined) throw new Error("The price cannot be read.");
      return { row: stored, created: true };
    },

    async startAttempt(id, expected) {
      const result = await db
        .updateTable("billing_plan_prices")
        .set({
          state: "pending",
          last_error_code: null,
          attempted_at: formatTimestamp(now()),
        })
        .where("id", "=", id)
        .where("state", "=", expected.state)
        .where(
          "attempted_at",
          expected.attemptedAt === null ? "is" : "=",
          expected.attemptedAt,
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async markFailed(id, code) {
      await db
        .updateTable("billing_plan_prices")
        .set({ state: "failed", last_error_code: code })
        .where("id", "=", id)
        .execute();
    },

    async recordCreated(id, paddlePriceId, snapshot, outcome) {
      assertSnapshot(snapshot);
      const row = await byColumn("id", id);
      if (row === undefined) throw new Error("The price cannot be read.");
      if (row.paddlePriceId !== null && row.paddlePriceId !== paddlePriceId)
        throw new Error("This row has another Paddle price.");
      try {
        await db
          .updateTable("billing_plan_prices")
          .set({
            // Set once; written again only when the row has none (the guard compares values on Postgres but not on SQLite).
            ...(row.paddlePriceId === null
              ? { paddle_price_id: paddlePriceId }
              : {}),
            paddle_product_id: snapshot.productId,
            price_type: snapshot.priceType,
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
            state: outcome.state,
            last_error_code: outcome.state === "failed" ? outcome.code : null,
            snapshot_at: formatTimestamp(now()),
          })
          .where("id", "=", id)
          .execute();
      } catch (cause) {
        if (isUniqueViolation(cause)) throw new PriceTakenError({ cause });
        throw cause;
      }
      const stored = await byColumn("id", id);
      if (stored === undefined) throw new Error("The price cannot be read.");
      return stored;
    },

    async markArchived(id) {
      await db
        .updateTable("billing_plan_prices")
        .set({ paddle_status: "archived", archived_at: formatTimestamp(now()) })
        .where("id", "=", id)
        .execute();
    },

    async listUnlinkedCreated(planId) {
      const rows = await db
        .selectFrom("billing_plan_prices")
        .selectAll()
        .where("plan_id", "=", planId)
        .where("origin", "=", "created")
        .where("archived_at", "is", null)
        .where((builder) =>
          builder.not(
            builder.exists(
              builder
                .selectFrom("billing_plan_versions")
                .select("billing_plan_versions.id")
                .where((inner) =>
                  inner.or([
                    inner(
                      "billing_plan_versions.monthly_price_id",
                      "=",
                      inner.ref("billing_plan_prices.id"),
                    ),
                    inner(
                      "billing_plan_versions.yearly_price_id",
                      "=",
                      inner.ref("billing_plan_prices.id"),
                    ),
                  ]),
                ),
            ),
          ),
        )
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toPrice);
    },
  };
}
