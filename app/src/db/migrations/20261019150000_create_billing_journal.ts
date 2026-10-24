// SPDX-License-Identifier: LicenseRef-Proprietary

// The balance journal of prepaid billing (ADR 0006, 2.7; #495): `billing_journal_entries`, one immutable row for each
// thing that happened to a workspace's money, and `billing_balances`, the cache of their sum. Both are new and empty and
// no existing row is touched, so an app of the previous release keeps working on the same database.
//
// Money is an integer in micro-USD (millionths of a US dollar), signed, and it must not be 32 bit: that would stop at
// about USD 2,147. SQLite's `integer` is 64 bit already, so the portable convention (text and integer columns only) holds
// there; Postgres needs `bigint`, and hands it back as text, so the repository converts every amount (`Number`, exact up
// to 2^53). The
// journal keeps opaque ids only: `job_id` and `actor_user_id` have no foreign key, because a job or a user may go (the
// account merge and the deletion of a user rewrite their references) while the journal stays as it was written; the
// workspace reference is a real foreign key.
//
// The checks restate what the repository keeps true, so a direct write cannot store an unknown type, an amount with the
// wrong sign, a usage whose parts do not add up to its amount, parts on another type, a reversal that is not a
// correction, or a job entry without its job. Written out because a check cannot take bound values; the lists are the
// same as BILLING_ENTRY_TYPES and ENTRY_SIGNS in src/billing/journal.ts (journal.test.ts fails when they drift apart).
//
// Triggers make the journal append-only on both engines, whichever release of the app or SQL tool writes: an update or a
// delete of an entry is refused (the pattern of the earlier plan-version guard). A mistake is a new `correction` entry.
// Triggers are not part of the schema builder, so the statements differ by engine. Postgres also refuses TRUNCATE, plain
// or through a cascade; SQLite has no TRUNCATE. One gap is a connection setting, not a trigger: SQLite fires a delete
// trigger for `insert or replace` only on a connection with `recursive_triggers` on. `openDatabase` sets it; the tools
// that open the file themselves (the admin CLI, backup and restore, the legacy import) and the `sqlite3` shell do not, so
// on those an `insert or replace` could still overwrite an entry. No code does that. `billing_balances` stays writable: it
// is a cache that `verify()` compares with the journal.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

/** The message every refusal carries; the app and its tests look for this name. */
const MESSAGE = "billing_journal_entries_immutable";

export const migration: Migration = {
  async up(db) {
    // The same value on both engines; the schema parity test reads `bigint` and `integer` as one kind.
    const postgres = databaseDriver(db) === "postgres";
    const money = postgres ? "bigint" : "integer";
    await db.schema
      .createTable("billing_journal_entries")
      // The order entries were written in, which `created_at` (a millisecond, written by the app) is not: a release and its
      // usage share one. An identity on Postgres; on SQLite an `integer primary key`, the row id, which hands out the
      // highest plus one and so only ever grows because no entry is ever deleted (the delete trigger). Not `autoincrement`:
      // the convention of this schema avoids it (migrate.integration.test.ts). The primary key on both engines, so the two
      // schemas have the same one. A reader that pages orders by it.
      .addColumn("seq", postgres ? "bigint" : "integer", (column) =>
        postgres
          ? column.primaryKey().generatedAlwaysAsIdentity()
          : column.primaryKey(),
      )
      .addColumn("id", "text", (column) => column.notNull().unique())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("type", "text", (column) => column.notNull())
      .addColumn("amount_micro_usd", money, (column) => column.notNull())
      // The job id or the provider reference (D14): with the type, the idempotency key inside a workspace.
      .addColumn("ref_key", "text", (column) => column.notNull())
      .addColumn("job_id", "text")
      .addColumn("review_kind", "text")
      .addColumn("minutes", "integer")
      .addColumn("ai_micro_usd", money)
      .addColumn("infra_micro_usd", money)
      .addColumn("reverses_entry_id", "text", (column) =>
        column.references("billing_journal_entries.id"),
      )
      .addColumn("provider", "text")
      .addColumn("provider_ref", "text")
      .addColumn("actor_user_id", "text")
      .addColumn("note", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_journal_entries_type_check",
        sql`type in ('top_up', 'start_credit', 'reservation', 'usage', 'release', 'refund', 'chargeback', 'correction')`,
      )
      .addCheckConstraint(
        "billing_journal_entries_sign_check",
        sql`(type in ('top_up', 'start_credit', 'release') and amount_micro_usd > 0) or (type in ('reservation', 'usage', 'refund', 'chargeback') and amount_micro_usd < 0) or (type = 'correction' and amount_micro_usd <> 0)`,
      )
      .addCheckConstraint(
        "billing_journal_entries_usage_check",
        sql`(type = 'usage' and ai_micro_usd is not null and infra_micro_usd is not null and ai_micro_usd >= 0 and infra_micro_usd >= 0 and ai_micro_usd + infra_micro_usd = -amount_micro_usd) or (type <> 'usage' and ai_micro_usd is null and infra_micro_usd is null)`,
      )
      .addCheckConstraint(
        "billing_journal_entries_reverses_check",
        sql`reverses_entry_id is null or type = 'correction'`,
      )
      .addCheckConstraint(
        "billing_journal_entries_job_check",
        sql`type not in ('reservation', 'usage', 'release') or job_id is not null`,
      )
      .addCheckConstraint(
        "billing_journal_entries_review_kind_check",
        sql`review_kind is null or review_kind in ('diff', 'dynamic')`,
      )
      .addCheckConstraint(
        "billing_journal_entries_minutes_check",
        sql`minutes is null or minutes >= 0`,
      )
      .execute();

    // D14: a thing happens once per workspace, type and key (a payment intent, a refund, a dispute, a job).
    await db.schema
      .createIndex("billing_journal_entries_key")
      .on("billing_journal_entries")
      .columns(["workspace_id", "type", "ref_key"])
      .unique()
      .execute();
    // A reversal happens once. NULLs do not collide on either engine.
    await db.schema
      .createIndex("billing_journal_entries_reverses")
      .on("billing_journal_entries")
      .column("reverses_entry_id")
      .unique()
      .execute();
    // The page of entries, newest first.
    await db.schema
      .createIndex("billing_journal_entries_page")
      .on("billing_journal_entries")
      .columns(["workspace_id", "seq"])
      .execute();

    await db.schema
      .createTable("billing_balances")
      .addColumn("workspace_id", "text", (column) =>
        column.primaryKey().notNull().references("workspaces.id"),
      )
      // The sum of all entries of the workspace. It already excludes held money (a reservation is a debit), and it is
      // below zero only through a settlement, a refund, a chargeback or a correction.
      .addColumn("balance_micro_usd", money, (column) =>
        column.notNull().defaultTo(0),
      )
      // What running reviews hold: the open reservations. Never below zero.
      .addColumn("reserved_micro_usd", money, (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_balances_reserved_check",
        sql`reserved_micro_usd >= 0`,
      )
      .execute();

    if (postgres) {
      await sql
        .raw(
          `create function billing_journal_entries_guard() returns trigger language plpgsql as $$
begin
  raise exception '${MESSAGE}: the journal is append-only, a mistake is a correction' using errcode = 'restrict_violation';
end
$$`,
        )
        .execute(db);
      await sql
        .raw(
          `create trigger billing_journal_entries_immutable before update or delete on billing_journal_entries for each row execute function billing_journal_entries_guard()`,
        )
        .execute(db);
      await sql
        .raw(
          `create trigger billing_journal_entries_no_truncate before truncate on billing_journal_entries for each statement execute function billing_journal_entries_guard()`,
        )
        .execute(db);
      return;
    }
    await sql
      .raw(
        `create trigger billing_journal_entries_never_updated before update on billing_journal_entries begin select raise(abort, '${MESSAGE}: the journal is append-only, a mistake is a correction'); end`,
      )
      .execute(db);
    await sql
      .raw(
        `create trigger billing_journal_entries_never_deleted before delete on billing_journal_entries begin select raise(abort, '${MESSAGE}: the journal is append-only, a mistake is a correction'); end`,
      )
      .execute(db);
  },

  async down(db) {
    // The tables go first: dropping a table drops its triggers on both engines.
    await db.schema.dropTable("billing_balances").execute();
    await db.schema.dropTable("billing_journal_entries").execute();
    if (databaseDriver(db) === "postgres")
      await sql
        .raw("drop function billing_journal_entries_guard()")
        .execute(db);
  },
};
