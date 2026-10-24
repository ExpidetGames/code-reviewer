// SPDX-License-Identifier: LicenseRef-Proprietary

// The billing profile of a workspace (ADR 0006, 2.13; #501): the legal name and address of the business that buys credit,
// an optional VAT ID, the business confirmation of the first top-up (time, user and terms version) and the id of the
// provider's customer object made from it. The table is new and empty and no existing row is touched, so an app of the
// previous release keeps working on the same database.
//
// This is customer data of the workspace: one row per workspace (the workspace id is the primary key), never logged, never
// in a webhook payload store, sent nowhere but to the payment provider. `customer_ref` is an opaque provider id and
// `customer_adapter` names the adapter it belongs to, so a ref of another adapter (or of the other Stripe environment, which
// the provider reports as not found) is never taken for the current one.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("billing_profiles")
      .addColumn("workspace_id", "text", (column) =>
        column.primaryKey().notNull().references("workspaces.id"),
      )
      .addColumn("legal_name", "text", (column) => column.notNull())
      // ISO 3166-1 alpha-2, upper case.
      .addColumn("country", "text", (column) => column.notNull())
      .addColumn("address_line1", "text", (column) => column.notNull())
      .addColumn("address_line2", "text")
      .addColumn("postal_code", "text", (column) => column.notNull())
      .addColumn("city", "text", (column) => column.notNull())
      // Normalized (no spaces), a light format check only: never a claim that the number is valid.
      .addColumn("vat_id", "text")
      // The business confirmation at the first top-up: when, by whom, and which terms. The time and the version go
      // together; the user may be gone later (set null) and the confirmation stays.
      .addColumn("confirmed_at", "text")
      .addColumn("confirmed_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("terms_version", "text")
      // The provider's customer made from this profile: the adapter id and its opaque id, both null until the first top-up.
      .addColumn("customer_adapter", "text")
      .addColumn("customer_ref", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_profiles_confirmation_check",
        sql`(confirmed_at is null) = (terms_version is null)`,
      )
      .addCheckConstraint(
        "billing_profiles_customer_check",
        sql`(customer_adapter is null) = (customer_ref is null)`,
      )
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("billing_profiles").execute();
  },
};
