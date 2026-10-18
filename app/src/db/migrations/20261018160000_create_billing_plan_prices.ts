// SPDX-License-Identifier: Apache-2.0

// `billing_plan_prices` and the links to it (#439, docs/decisions/0005-providers-model-catalog-and-paddle-billing.md, 2.11;
// src/billing/README.md): the cache of the Paddle prices a plan version is sold with, the Paddle product a plan was bound
// to, and the two links from a version to its monthly and its yearly price.
//
// - `billing_plan_prices`: one row per Paddle price the app knows. The facts (interval, currency, amount, tax mode,
//   status, trial, quantity limits) are what Paddle said at `snapshot_at`; the app never writes them back. `paddle_price_id` is unique, so a
//   price belongs to one plan and several versions may share it. The amount is the string of minor units Paddle sent (text,
//   so a changed price of any size is cached whole). `origin`, `intent_id`, `state` and `last_error_code` are for the issue
//   that creates prices through the API (#440); a linked price is `linked`, `ready`, without an intent.
// - `billing_plans.paddle_product_id` (+ `paddle_product_env`): set when the first price of the plan is linked; every later
//   price must belong to it.
// - `billing_plan_versions.monthly_price_id` / `yearly_price_id`: the only columns of a version beside `role` that change
//   after it was saved. They say which Paddle price a slot is sold with, and are set by linking.
//
// Forward only for an app of the previous release: one new empty table and nullable columns without a default, so no row is
// touched and the previous release, which names its columns, never sees them. On Postgres the guard of the versions is
// replaced so that the two links may change (the SQLite trigger lists the frozen columns and does not name them).
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

/** The message every refusal carries; the app and its tests look for this name. */
const MESSAGE = "billing_plan_versions_immutable";

/** Postgres: a link, once set, may be replaced by another but never cleared (review of #468, N1). */
const LINKS_KEPT = `  if (old.monthly_price_id is not null and new.monthly_price_id is null) or (old.yearly_price_id is not null and new.yearly_price_id is null) then
    raise exception '${MESSAGE}: a price link is replaced, never cleared' using errcode = 'restrict_violation';
  end if;
`;

function guardFunction(mutable: readonly string[], keepLinks: boolean): string {
  const removed = mutable.map((column) => ` - '${column}'`).join("");
  return `create or replace function billing_plan_versions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '${MESSAGE}: a plan version is never deleted' using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new)${removed}) is distinct from (to_jsonb(old)${removed}) then
    raise exception '${MESSAGE}: a plan version changes only its role and its price links' using errcode = 'restrict_violation';
  end if;
${keepLinks ? LINKS_KEPT : ""}  return new;
end
$$`;
}

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("billing_plan_prices")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("plan_id", "text", (column) =>
        column.notNull().references("billing_plans.id").onDelete("restrict"),
      )
      .addColumn("paddle_price_id", "text")
      .addColumn("paddle_product_id", "text", (column) => column.notNull())
      .addColumn("paddle_env", "text", (column) => column.notNull())
      .addColumn("interval", "text", (column) => column.notNull())
      .addColumn("frequency", "integer", (column) => column.notNull())
      .addColumn("currency", "text", (column) => column.notNull())
      .addColumn("unit_amount_minor", "text", (column) => column.notNull())
      .addColumn("tax_mode", "text", (column) => column.notNull())
      .addColumn("has_overrides", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("trial_days", "integer")
      .addColumn("quantity_min", "integer", (column) => column.notNull())
      .addColumn("quantity_max", "integer", (column) => column.notNull())
      .addColumn("paddle_status", "text")
      .addColumn("origin", "text", (column) => column.notNull())
      .addColumn("intent_id", "text")
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("last_error_code", "text")
      .addColumn("snapshot_at", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("archived_at", "text")
      .addCheckConstraint(
        "billing_plan_prices_origin_check",
        sql`origin in ('created', 'linked')`,
      )
      .addCheckConstraint(
        "billing_plan_prices_state_check",
        sql`state in ('pending', 'ready', 'failed')`,
      )
      .addCheckConstraint(
        "billing_plan_prices_env_check",
        sql`paddle_env in ('sandbox', 'live')`,
      )
      .addCheckConstraint(
        "billing_plan_prices_overrides_check",
        sql`has_overrides in (0, 1)`,
      )
      .addCheckConstraint(
        "billing_plan_prices_quantity_check",
        sql`quantity_min >= 1 and quantity_max >= 1`,
      )
      .addCheckConstraint(
        "billing_plan_prices_amount_check",
        sql`length(unit_amount_minor) between 1 and 30`,
      )
      // A price that is ready exists at Paddle and has been read once.
      .addCheckConstraint(
        "billing_plan_prices_ready_check",
        sql`state <> 'ready' or (paddle_price_id is not null and paddle_status is not null and snapshot_at is not null)`,
      )
      .execute();
    await db.schema
      .createIndex("billing_plan_prices_paddle_price")
      .on("billing_plan_prices")
      .column("paddle_price_id")
      .unique()
      .execute();
    await db.schema
      .createIndex("billing_plan_prices_intent")
      .on("billing_plan_prices")
      .column("intent_id")
      .unique()
      .execute();
    await db.schema
      .createIndex("billing_plan_prices_plan")
      .on("billing_plan_prices")
      .column("plan_id")
      .execute();

    await db.schema
      .alterTable("billing_plans")
      .addColumn("paddle_product_id", "text")
      .execute();
    await db.schema
      .alterTable("billing_plans")
      .addColumn("paddle_product_env", "text")
      .execute();
    await db.schema
      .alterTable("billing_plan_versions")
      .addColumn("monthly_price_id", "text", (column) =>
        column.references("billing_plan_prices.id").onDelete("restrict"),
      )
      .execute();
    await db.schema
      .alterTable("billing_plan_versions")
      .addColumn("yearly_price_id", "text", (column) =>
        column.references("billing_plan_prices.id").onDelete("restrict"),
      )
      .execute();

    // SQLite: the trigger names the frozen columns, and the two links are not among them. Postgres compares the whole row.
    if (databaseDriver(db) === "postgres")
      await sql
        .raw(
          guardFunction(
            ["role", "created_by", "monthly_price_id", "yearly_price_id"],
            true,
          ),
        )
        .execute(db);
    else
      // SQLite: the trigger of the frozen columns does not name the links; this one lets them change but not become empty.
      // The stored row is read with a select (it is not changed yet in a `before` trigger): a rebuild check of the workspace
      // migration looks for the text "_old" in every schema object, and the reference to the old row would read as a leftover.
      for (const column of ["monthly_price_id", "yearly_price_id"])
        await sql
          .raw(
            `create trigger billing_plan_versions_${column}_kept before update of ${column} on billing_plan_versions when new.${column} is null and (select ${column} from billing_plan_versions where id = new.id) is not null begin select raise(abort, '${MESSAGE}: a price link is replaced, never cleared'); end`,
          )
          .execute(db);
  },

  async down(db) {
    if (databaseDriver(db) === "postgres")
      await sql.raw(guardFunction(["role", "created_by"], false)).execute(db);
    else
      for (const column of ["monthly_price_id", "yearly_price_id"])
        await sql
          .raw(`drop trigger billing_plan_versions_${column}_kept`)
          .execute(db);
    await db.schema
      .alterTable("billing_plan_versions")
      .dropColumn("yearly_price_id")
      .execute();
    await db.schema
      .alterTable("billing_plan_versions")
      .dropColumn("monthly_price_id")
      .execute();
    await db.schema
      .alterTable("billing_plans")
      .dropColumn("paddle_product_env")
      .execute();
    await db.schema
      .alterTable("billing_plans")
      .dropColumn("paddle_product_id")
      .execute();
    await db.schema.dropTable("billing_plan_prices").execute();
  },
};
