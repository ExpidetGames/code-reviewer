// SPDX-License-Identifier: Apache-2.0

// Access to the billing_plan_versions table: the sold unit of a plan (#438, ADR 0005, 2.11, decision M6). Instance level,
// like the plans. A version is immutable after creation: this module offers no update at all, and the only change a row
// ever gets is its `role`, from `current` to `legacy`, inside `createNext` when a newer version replaces it. A subscriber
// is pinned to a version (a later issue), so nothing here deletes one either (the table's foreign key restricts it).
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import {
  PLAN_VERSION_ROLES,
  type PlanTerms,
  type PlanVersionRole,
} from "../../admin/ui/plans-view.ts";
import { KEY_MODES } from "../../workspaces/entitlements.ts";
import {
  LIMITS_ADDED_LATER,
  validateLimits,
} from "../../workspaces/entitlements-validation.ts";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
import { errorCode } from "../errors.ts";
import type { BillingPlanVersionsTable, Database } from "../schema.ts";
import { PlanChangedError } from "./billing-plans-repository.ts";

export type PlanVersionRow = PlanTerms & {
  id: string;
  planId: string;
  number: number;
  role: PlanVersionRole;
  createdAt: string;
  createdBy: string | null;
  /** The `billing_plan_prices` row each slot is sold with (#439); null until a price is linked. */
  monthlyPriceId: string | null;
  yearlyPriceId: string | null;
};

/** Stable code of a refused clearing of a link (`PriceLinkNotClearableError`; the database refuses it with the same words). */
export const PRICE_LINK_NOT_CLEARABLE = "price_link_not_clearable";

/** Thrown by `setPriceLink` when asked to clear a link: a slot that was linked once is relinked, never emptied. */
export class PriceLinkNotClearableError extends Error {
  readonly code = PRICE_LINK_NOT_CLEARABLE;
  constructor() {
    super("A price link is never cleared, only replaced.");
    this.name = "PriceLinkNotClearableError";
  }
}

export type PriceLinkChange =
  | { ok: true }
  /** The version is not the current one (any more). */
  | { ok: false; reason: "not_current" }
  /** The slot holds another link than the one the caller read: somebody linked meanwhile. */
  | { ok: false; reason: "link_changed" };

export type BillingPlanVersionsRepository = {
  /** The versions of one plan, newest first. */
  list(planId: string): Promise<PlanVersionRow[]>;
  /** The versions of several plans, each plan's newest first. */
  listForPlans(planIds: readonly string[]): Promise<PlanVersionRow[]>;
  /** What a new subscriber gets: the version with the role `current`. */
  current(planId: string): Promise<PlanVersionRow | undefined>;
  /**
   * Saves the next version as the current one and turns the previous current version into `legacy`, in one transaction.
   * `basedOn` is the number of the version the caller saw as current (0 for a plan without one): a different number
   * means somebody saved meanwhile, and nothing is written (`PlanChangedError`, also when two writers race).
   */
  createNext(
    planId: string,
    terms: PlanTerms,
    createdBy: string | null,
    basedOn: number,
  ): Promise<PlanVersionRow>;
  /**
   * Links the version's slot to a `billing_plan_prices` row (#439). The one change besides the role that a version gets
   * after it was saved: it says which Paddle price the slot is sold with, never what it costs. Written to the current
   * version only, in the statement itself: a version that a newer one replaced meanwhile keeps the prices its subscribers
   * bought and the answer is `not_current` (the caller's earlier read of the role proves nothing once it is written).
   * `expected` is the link the caller read in the slot (`null` for none): the write happens only if the slot still holds
   * it, otherwise nothing is written and the answer is `link_changed` (two admins relinking at once: one of them wins).
   * A link is replaced, never cleared: `priceId` is always a row (`PriceLinkNotClearableError`).
   */
  setPriceLink(
    versionId: string,
    slot: "month" | "year",
    priceId: string,
    expected: string | null,
  ): Promise<PriceLinkChange>;
};

type Row = Selectable<BillingPlanVersionsTable>;

function toVersion(row: Row): PlanVersionRow {
  const role = PLAN_VERSION_ROLES.find((candidate) => candidate === row.role);
  const keyMode = KEY_MODES.find((candidate) => candidate === row.key_mode);
  if (role === undefined || keyMode === undefined)
    throw new Error(`Billing plan version ${row.id} has an unknown value.`);
  // Written by this module only, from validated terms; read again with the rules of reading, never trusted blindly.
  const limits = validateLimits(
    decodeJson(row.limits),
    LIMITS_ADDED_LATER,
    true,
  );
  if (!limits.ok)
    throw new Error(`Billing plan version ${row.id} has damaged limits.`);
  return {
    id: row.id,
    planId: row.plan_id,
    number: row.number,
    role,
    keyMode,
    limits: limits.value,
    modelAccess:
      row.model_access === null
        ? null
        : decodeJson<{ catalogEntries: string[] | null }>(row.model_access),
    monthlyAmountMinor: row.monthly_amount_minor,
    yearlyAmountMinor: row.yearly_amount_minor,
    createdAt: row.created_at,
    createdBy: row.created_by,
    monthlyPriceId: row.monthly_price_id,
    yearlyPriceId: row.yearly_price_id,
  };
}

/** SQLite names the constraint kind, Postgres answers SQLSTATE 23505. */
function isUniqueViolation(cause: unknown): boolean {
  const code = errorCode(cause);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505";
}

export function createBillingPlanVersionsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newId: () => string = () => `bpv_${randomUUID().replaceAll("-", "")}`,
): BillingPlanVersionsRepository {
  async function listForPlans(planIds: readonly string[]) {
    if (planIds.length === 0) return [];
    const rows = await db
      .selectFrom("billing_plan_versions")
      .selectAll()
      .where("plan_id", "in", [...planIds])
      .orderBy("plan_id", "asc")
      .orderBy("number", "desc")
      .execute();
    return rows.map(toVersion);
  }

  return {
    list: (planId) => listForPlans([planId]),
    listForPlans,

    async setPriceLink(versionId, slot, priceId, expected) {
      if (slot !== "month" && slot !== "year")
        throw new Error("A price slot is month or year.");
      // Callers are typed, but a link cleared by a lax caller would be a version sold without its price.
      if (typeof priceId !== "string") throw new PriceLinkNotClearableError();
      const column = slot === "month" ? "monthly_price_id" : "yearly_price_id";
      const updated = await db
        .updateTable("billing_plan_versions")
        .set(
          slot === "month"
            ? { monthly_price_id: priceId }
            : { yearly_price_id: priceId },
        )
        .where("id", "=", versionId)
        .where("role", "=", "current")
        .where(column, expected === null ? "is" : "=", expected)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) return { ok: true };
      // Nothing was written: say why from what is there now.
      const found = await db
        .selectFrom("billing_plan_versions")
        .select(["role", column])
        .where("id", "=", versionId)
        .executeTakeFirst();
      if (found === undefined || found.role !== "current")
        return { ok: false, reason: "not_current" };
      // Somebody linked the very price asked for: the slot is as the caller wants it.
      if (found[column] === priceId) return { ok: true };
      return { ok: false, reason: "link_changed" };
    },

    async current(planId) {
      const row = await db
        .selectFrom("billing_plan_versions")
        .selectAll()
        .where("plan_id", "=", planId)
        .where("role", "=", "current")
        .executeTakeFirst();
      return row === undefined ? undefined : toVersion(row);
    },

    async createNext(planId, terms, createdBy, basedOn) {
      const write = async (trx: Kysely<Database>) => {
        const current = await trx
          .selectFrom("billing_plan_versions")
          .select(["id", "number"])
          .where("plan_id", "=", planId)
          .where("role", "=", "current")
          .executeTakeFirst();
        if ((current?.number ?? 0) !== basedOn) throw new PlanChangedError();
        if (current !== undefined) {
          // The one change a version ever gets. Guarded: a writer that lost the race finds it already legacy.
          const demoted = await trx
            .updateTable("billing_plan_versions")
            .set({ role: "legacy" })
            .where("id", "=", current.id)
            .where("role", "=", "current")
            .executeTakeFirst();
          if (Number(demoted.numUpdatedRows) !== 1)
            throw new PlanChangedError();
        }
        const id = newId();
        await trx
          .insertInto("billing_plan_versions")
          .values({
            id,
            plan_id: planId,
            number: basedOn + 1,
            role: "current",
            key_mode: terms.keyMode,
            limits: encodeJson(terms.limits),
            model_access:
              terms.modelAccess === null ? null : encodeJson(terms.modelAccess),
            monthly_amount_minor: terms.monthlyAmountMinor,
            yearly_amount_minor: terms.yearlyAmountMinor,
            created_at: formatTimestamp(now()),
            created_by: createdBy,
          })
          .execute();
        const created = await trx
          .selectFrom("billing_plan_versions")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        return toVersion(created);
      };
      try {
        return await (db.isTransaction
          ? write(db)
          : db.transaction().execute(write));
      } catch (cause) {
        // Two writers read the same current version: the unique indexes let one through.
        if (isUniqueViolation(cause)) throw new PlanChangedError({ cause });
        throw cause;
      }
    },
  };
}
