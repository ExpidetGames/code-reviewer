// SPDX-License-Identifier: LicenseRef-Proprietary

// The admin's decisions about models of the models.dev catalog (#549, src/model-prices/README.md): two new tables, empty,
// so no existing row is touched and an app of the previous release (which never reads them) keeps working on the same
// database. Instance level: they are configuration of the installation, not customer data.
//
// `model_enablements`: whether the admin enabled a model for the managed key, one row per model and changed in place
// (who and when are those of the last change). No row means the admin has not looked at the model ("new"); `enabled = 0`
// means they looked and do not want it.
//
// `model_price_confirmations`: the append-only history of what an admin confirmed as a model's price. The latest row of a
// model counts. `price` is the confirmed price book and `reference_price` the price models.dev and the override file
// stated at that time (both JSON text, amounts as decimal strings of whole micro-USD per million tokens, see
// src/model-prices/price-book.ts); `reference_hash` is the hash of the reference, and the price counts as changed (stale)
// once today's reference hashes differently. `source` is `catalog` (confirmed as shown, so there was a reference) or `admin`
// (corrected, with a reason). Triggers make the history append-only on both engines, whichever release of the app or SQL
// tool writes: an update or a delete is refused (the pattern of the billing journal). The user who confirmed has no foreign
// key: the history stays as it was written when a user is deleted.
//
// Both tables refer to the catalog's model row, which is never deleted.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

/** The message every refusal carries; the app and its tests look for this name. */
const MESSAGE = "model_price_confirmations_immutable";

export const migration: Migration = {
  async up(db) {
    const postgres = databaseDriver(db) === "postgres";

    await db.schema
      .createTable("model_enablements")
      .addColumn("provider_id", "text", (column) => column.notNull())
      .addColumn("model_id", "text", (column) => column.notNull())
      .addColumn("enabled", "integer", (column) => column.notNull())
      .addColumn("changed_by", "text")
      .addColumn("changed_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("model_enablements_pk", [
        "provider_id",
        "model_id",
      ])
      .addForeignKeyConstraint(
        "model_enablements_model_fk",
        ["provider_id", "model_id"],
        "models_dev_models",
        ["provider_id", "model_id"],
      )
      .addCheckConstraint(
        "model_enablements_enabled_check",
        sql`enabled in (0, 1)`,
      )
      .execute();

    await db.schema
      .createTable("model_price_confirmations")
      // The order rows were written in, which a timestamp is not: two confirmations may share a millisecond. An identity
      // on Postgres; on SQLite an `integer primary key`, which only ever grows because no row is deleted (the trigger).
      .addColumn("seq", "integer", (column) =>
        postgres
          ? column.primaryKey().generatedAlwaysAsIdentity()
          : column.primaryKey(),
      )
      .addColumn("provider_id", "text", (column) => column.notNull())
      .addColumn("model_id", "text", (column) => column.notNull())
      .addColumn("source", "text", (column) => column.notNull())
      .addColumn("price", "text", (column) => column.notNull())
      .addColumn("reference_price", "text")
      .addColumn("reference_hash", "text", (column) => column.notNull())
      .addColumn("reason", "text")
      .addColumn("confirmed_by", "text")
      .addColumn("confirmed_at", "text", (column) => column.notNull())
      .addForeignKeyConstraint(
        "model_price_confirmations_model_fk",
        ["provider_id", "model_id"],
        "models_dev_models",
        ["provider_id", "model_id"],
      )
      .addCheckConstraint(
        "model_price_confirmations_source_check",
        sql`source in ('catalog', 'admin')`,
      )
      // A correction says why; a confirmation as shown has the price it confirmed.
      .addCheckConstraint(
        "model_price_confirmations_reason_check",
        sql`source = 'catalog' or reason is not null`,
      )
      .addCheckConstraint(
        "model_price_confirmations_reference_check",
        sql`source = 'admin' or reference_price is not null`,
      )
      .execute();

    // The latest row of a model, and its history.
    await db.schema
      .createIndex("model_price_confirmations_model")
      .on("model_price_confirmations")
      .columns(["provider_id", "model_id", "seq"])
      .execute();

    if (postgres) {
      await sql
        .raw(
          `create function model_price_confirmations_guard() returns trigger language plpgsql as $$
begin
  raise exception '${MESSAGE}: the history is append-only, a mistake is a new confirmation' using errcode = 'restrict_violation';
end
$$`,
        )
        .execute(db);
      await sql
        .raw(
          `create trigger model_price_confirmations_immutable before update or delete on model_price_confirmations for each row execute function model_price_confirmations_guard()`,
        )
        .execute(db);
      await sql
        .raw(
          `create trigger model_price_confirmations_no_truncate before truncate on model_price_confirmations for each statement execute function model_price_confirmations_guard()`,
        )
        .execute(db);
      return;
    }
    await sql
      .raw(
        `create trigger model_price_confirmations_never_updated before update on model_price_confirmations begin select raise(abort, '${MESSAGE}: the history is append-only, a mistake is a new confirmation'); end`,
      )
      .execute(db);
    await sql
      .raw(
        `create trigger model_price_confirmations_never_deleted before delete on model_price_confirmations begin select raise(abort, '${MESSAGE}: the history is append-only, a mistake is a new confirmation'); end`,
      )
      .execute(db);
  },

  async down(db) {
    // The tables go first: dropping a table drops its triggers on both engines.
    await db.schema.dropTable("model_price_confirmations").execute();
    await db.schema.dropTable("model_enablements").execute();
    if (databaseDriver(db) === "postgres")
      await sql
        .raw("drop function model_price_confirmations_guard()")
        .execute(db);
  },
};
