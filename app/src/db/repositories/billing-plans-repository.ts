// SPDX-License-Identifier: Apache-2.0

// Access to the billing_plans table: the plans the operator sells (#438, src/billing/README.md, ADR 0005, 2.11).
// Instance level: a plan is configuration, not customer data, and no workspace owns one. The service above this module
// holds the rules (src/billing/plan-rules.ts); this one stores, reads and guards what only the database can keep true
// on several app instances: a plan key is unique, a change is made against the time it was read, and the Popular flag
// moves from one plan to another in one transaction, backed by a partial unique index. Nothing here is read while
// billing is off (src/billing/enabled.ts).
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import {
  PLAN_KINDS,
  type PlanKind,
  type PlanMetadata,
} from "../../admin/ui/plans-view.ts";
import { decodeBoolean, encodeBoolean, formatTimestamp } from "../codecs.ts";
import { errorCode } from "../errors.ts";
import type { BillingPlansTable, Database } from "../schema.ts";

/** Thrown by `insert` when another plan has the key. */
export class PlanKeyTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super("Another plan has this key.", options);
    this.name = "PlanKeyTakenError";
  }
}

/**
 * Thrown when the database refused a write that the caller's checks had let through, because another request got there
 * first: a second Popular plan, a second Free plan, a version number taken, a second current version.
 */
export class PlanChangedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The plan changed since it was read.", options);
    this.name = "PlanChangedError";
  }
}

export type PlanRow = PlanMetadata & {
  id: string;
  planKey: string;
  kind: PlanKind;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewPlanRow = {
  planKey: string;
  kind: PlanKind;
  metadata: PlanMetadata;
};

export type BillingPlansRepository = {
  /** Every plan, ascending by `sort`, ties by plan key. */
  list(): Promise<PlanRow[]>;
  get(planKey: string): Promise<PlanRow | undefined>;
  /** Inserts a plan. `PlanKeyTakenError` for a key in use; `PlanChangedError` for a second Popular or Free plan. */
  insert(input: NewPlanRow, updatedBy: string | null): Promise<PlanRow>;
  /**
   * Replaces the display fields of a plan if it is still as it was read (`expectedUpdatedAt`). Setting `popular` clears
   * it on the plan that had it in the same transaction and names that plan. Undefined when there is no such plan or
   * it changed since; nothing is written then.
   */
  update(
    planKey: string,
    metadata: PlanMetadata,
    updatedBy: string | null,
    expectedUpdatedAt: string,
  ): Promise<{ plan: PlanRow; clearedPopular: string | null } | undefined>;
  /** Hides the plan from new subscribers (and clears `offered` and `popular`), or restores it (still not offered). */
  setArchived(
    planKey: string,
    archived: boolean,
    updatedBy: string | null,
  ): Promise<PlanRow | undefined>;
  /** Deletes a plan that has no version; false for a plan that has one and for a key that is not there. */
  remove(planKey: string): Promise<boolean>;
};

type Row = Selectable<BillingPlansTable>;

class StaleSignal extends Error {}

function kindOf(row: Pick<Row, "id" | "kind">): PlanKind {
  const kind = PLAN_KINDS.find((candidate) => candidate === row.kind);
  if (kind === undefined)
    throw new Error(`Billing plan ${row.id} has an unknown kind.`);
  return kind;
}

function toPlan(row: Row): PlanRow {
  return {
    id: row.id,
    planKey: row.plan_key,
    kind: kindOf(row),
    name: row.name,
    description: row.description,
    sort: row.sort,
    offered: decodeBoolean(row.offered),
    popular: decodeBoolean(row.popular),
    contactTarget: row.contact_target,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite names the constraint kind, Postgres answers SQLSTATE 23505. */
function isUniqueViolation(cause: unknown): boolean {
  const code = errorCode(cause);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505";
}

function inTransaction<T>(
  db: Kysely<Database>,
  work: (executor: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? work(db) : db.transaction().execute(work);
}

export function createBillingPlansRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newId: () => string = () => `bpl_${randomUUID().replaceAll("-", "")}`,
): BillingPlansRepository {
  async function get(
    executor: Kysely<Database>,
    planKey: string,
  ): Promise<PlanRow | undefined> {
    const row = await executor
      .selectFrom("billing_plans")
      .selectAll()
      .where("plan_key", "=", planKey)
      .executeTakeFirst();
    return row === undefined ? undefined : toPlan(row);
  }

  return {
    async list() {
      const rows = await db
        .selectFrom("billing_plans")
        .selectAll()
        .orderBy("sort", "asc")
        .orderBy("plan_key", "asc")
        .execute();
      return rows.map(toPlan);
    },

    get: (planKey) => get(db, planKey),

    async insert(input, updatedBy) {
      const timestamp = formatTimestamp(now());
      try {
        await db
          .insertInto("billing_plans")
          .values({
            id: newId(),
            plan_key: input.planKey,
            name: input.metadata.name,
            description: input.metadata.description,
            sort: input.metadata.sort,
            kind: input.kind,
            offered: encodeBoolean(input.metadata.offered),
            popular: encodeBoolean(input.metadata.popular),
            contact_target: input.metadata.contactTarget,
            archived_at: null,
            created_at: timestamp,
            updated_at: timestamp,
            updated_by: updatedBy,
          })
          .execute();
      } catch (cause) {
        if (!isUniqueViolation(cause)) throw cause;
        if ((await get(db, input.planKey)) !== undefined)
          throw new PlanKeyTakenError({ cause });
        throw new PlanChangedError({ cause });
      }
      const created = await get(db, input.planKey);
      if (created === undefined)
        throw new Error("The plan was inserted but cannot be read.");
      return created;
    },

    async update(planKey, metadata, updatedBy, expectedUpdatedAt) {
      const timestamp = formatTimestamp(now());
      try {
        return await inTransaction(db, async (trx) => {
          const stored = await get(trx, planKey);
          if (stored === undefined || stored.updatedAt !== expectedUpdatedAt)
            throw new StaleSignal();
          let clearedPopular: string | null = null;
          if (metadata.popular && !stored.popular) {
            const holder = await trx
              .selectFrom("billing_plans")
              .select("plan_key")
              .where("popular", "=", 1)
              .where("plan_key", "<>", planKey)
              .executeTakeFirst();
            if (holder !== undefined) {
              clearedPopular = holder.plan_key;
              await trx
                .updateTable("billing_plans")
                .set({
                  popular: 0,
                  updated_at: timestamp,
                  updated_by: updatedBy,
                })
                .where("plan_key", "=", holder.plan_key)
                .execute();
            }
          }
          const updated = await trx
            .updateTable("billing_plans")
            .set({
              name: metadata.name,
              description: metadata.description,
              sort: metadata.sort,
              offered: encodeBoolean(metadata.offered),
              popular: encodeBoolean(metadata.popular),
              contact_target: metadata.contactTarget,
              updated_at: timestamp,
              updated_by: updatedBy,
            })
            .where("plan_key", "=", planKey)
            .where("updated_at", "=", expectedUpdatedAt)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) !== 1) throw new StaleSignal();
          const plan = await get(trx, planKey);
          if (plan === undefined) throw new StaleSignal();
          return { plan, clearedPopular };
        });
      } catch (cause) {
        if (cause instanceof StaleSignal) return undefined;
        // Two admins set Popular on different plans at the same time: the index let one through.
        if (isUniqueViolation(cause)) throw new PlanChangedError({ cause });
        throw cause;
      }
    },

    async setArchived(planKey, archived, updatedBy) {
      const timestamp = formatTimestamp(now());
      await db
        .updateTable("billing_plans")
        .set({
          archived_at: archived ? timestamp : null,
          ...(archived ? { offered: 0, popular: 0 } : {}),
          updated_at: timestamp,
          updated_by: updatedBy,
        })
        .where("plan_key", "=", planKey)
        .execute();
      return get(db, planKey);
    },

    async remove(planKey) {
      const result = await db
        .deleteFrom("billing_plans")
        .where("plan_key", "=", planKey)
        .where((builder) =>
          builder.not(
            builder.exists(
              builder
                .selectFrom("billing_plan_versions")
                .select("id")
                .whereRef(
                  "billing_plan_versions.plan_id",
                  "=",
                  "billing_plans.id",
                ),
            ),
          ),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
