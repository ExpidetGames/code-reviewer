// SPDX-License-Identifier: Apache-2.0

// `billing_plans` and `billing_plan_versions` (#438, docs/decisions/0005-providers-model-catalog-and-paddle-billing.md,
// 2.11; src/billing/README.md): the plans the operator sells and their versions. A version is the sold unit: it pins
// the key mode, the limits, the model access and the prices of a plan and is never edited, except for its `role`
// (`current` becomes `legacy` when a newer version is saved). Instance level: no workspace owns a plan. The tables are
// new and empty and no existing row is touched, so an app of the previous release (which never reads them) keeps working
// on the same database; billing off never reads them (src/billing/enabled.ts).
//
// What the database keeps true on its own, whichever app instance writes: a plan key is unique; at most one plan is
// `popular` (a partial unique index, ADR 0005, 2.18) and only a `paid` one; at most one plan is `free`; a contact target
// belongs to a `contact` plan; a plan has at most one `current` version and a version number once; a price is a
// positive integer (USD minor units, `null` for none) and a yearly price needs a monthly one; an `own` version has no
// model access. Booleans are 0 or 1, JSON is text (src/db/README.md, "Portable schema conventions"). Versions are
// never deleted (`on delete restrict`): subscribers are pinned to them.
//
// The lists in the checks restate `PLAN_KINDS`, `PLAN_VERSION_ROLES` and `KEY_MODES` of the code.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("billing_plans")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("plan_key", "text", (column) => column.notNull())
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("description", "text", (column) =>
        column.notNull().defaultTo(""),
      )
      .addColumn("sort", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("offered", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("popular", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("contact_target", "text")
      .addColumn("archived_at", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("updated_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addCheckConstraint(
        "billing_plans_kind_check",
        sql`kind in ('free', 'paid', 'contact')`,
      )
      .addCheckConstraint(
        "billing_plans_flags_check",
        sql`offered in (0, 1) and popular in (0, 1)`,
      )
      .addCheckConstraint(
        "billing_plans_popular_paid_check",
        sql`popular = 0 or kind = 'paid'`,
      )
      .addCheckConstraint(
        "billing_plans_contact_target_check",
        sql`contact_target is null or kind = 'contact'`,
      )
      .execute();

    await db.schema
      .createIndex("billing_plans_plan_key")
      .on("billing_plans")
      .column("plan_key")
      .unique()
      .execute();
    // At most one Popular plan: a second `popular = 1` row is refused by the database (ADR 0005, 2.18).
    await db.schema
      .createIndex("billing_plans_one_popular")
      .on("billing_plans")
      .column("popular")
      .unique()
      .where(sql<boolean>`popular = 1`)
      .execute();
    // One Free plan: it drives the default entitlements.
    await db.schema
      .createIndex("billing_plans_one_free")
      .on("billing_plans")
      .column("kind")
      .unique()
      .where(sql<boolean>`kind = 'free'`)
      .execute();

    await db.schema
      .createTable("billing_plan_versions")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("plan_id", "text", (column) =>
        column.notNull().references("billing_plans.id").onDelete("restrict"),
      )
      .addColumn("number", "integer", (column) => column.notNull())
      .addColumn("role", "text", (column) => column.notNull())
      .addColumn("key_mode", "text", (column) => column.notNull())
      .addColumn("limits", "text", (column) => column.notNull())
      .addColumn("model_access", "text")
      .addColumn("monthly_amount_minor", "integer")
      .addColumn("yearly_amount_minor", "integer")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("created_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addCheckConstraint(
        "billing_plan_versions_role_check",
        sql`role in ('current', 'legacy')`,
      )
      .addCheckConstraint(
        "billing_plan_versions_key_mode_check",
        sql`key_mode in ('own', 'managed')`,
      )
      .addCheckConstraint(
        "billing_plan_versions_number_check",
        sql`number >= 1`,
      )
      .addCheckConstraint(
        "billing_plan_versions_prices_check",
        sql`(monthly_amount_minor is null or monthly_amount_minor > 0) and (yearly_amount_minor is null or (yearly_amount_minor > 0 and monthly_amount_minor is not null))`,
      )
      .addCheckConstraint(
        "billing_plan_versions_own_model_access_check",
        sql`key_mode = 'managed' or model_access is null`,
      )
      .execute();

    await db.schema
      .createIndex("billing_plan_versions_plan_number")
      .on("billing_plan_versions")
      .columns(["plan_id", "number"])
      .unique()
      .execute();
    await db.schema
      .createIndex("billing_plan_versions_one_current")
      .on("billing_plan_versions")
      .column("plan_id")
      .unique()
      .where(sql<boolean>`role = 'current'`)
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("billing_plan_versions").execute();
    await db.schema.dropTable("billing_plans").execute();
  },
};
