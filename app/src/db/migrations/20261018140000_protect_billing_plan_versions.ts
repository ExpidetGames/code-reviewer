// SPDX-License-Identifier: Apache-2.0

// The database refuses what a plan version must never go through (#438, review of #462, N6): a version is the sold unit,
// and subscribers are pinned to it, so no row of `billing_plan_versions` is deleted and no column of it is updated but
// `role` (`current` becomes `legacy` when a newer version is saved) and `created_by` (the account merge and the deletion of
// a user rewrite who made a version, an audit reference). Until now only the repository had no way to do it; this holds
// for every writer, whichever release of the app or whichever SQL it is. Adds triggers only: no row is read or changed,
// so an app of the previous release keeps working on the same database.
//
// Triggers are not part of the schema builder, so the statements differ by engine. Postgres compares the whole row as
// JSON without `role` and `created_by`, so a column that a later migration adds is protected without touching the
// trigger. SQLite lists the columns of the table; a test (billing-plan-versions-repository.integration.test.ts) updates
// every column the table has and fails for one the trigger does not name, so the next migration that adds a column to
// the table has to extend the trigger.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

/** The message every refusal carries; the app and its tests look for this name. */
const MESSAGE = "billing_plan_versions_immutable";

/** The columns an update may not change on SQLite: everything but `role` and `created_by`. */
const FROZEN_COLUMNS = [
  "id",
  "plan_id",
  "number",
  "key_mode",
  "limits",
  "model_access",
  "monthly_amount_minor",
  "yearly_amount_minor",
  "created_at",
] as const;

export const migration: Migration = {
  async up(db) {
    if (databaseDriver(db) === "postgres") {
      await sql
        .raw(
          `create function billing_plan_versions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '${MESSAGE}: a plan version is never deleted' using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new) - 'role' - 'created_by') is distinct from (to_jsonb(old) - 'role' - 'created_by') then
    raise exception '${MESSAGE}: a plan version changes only its role' using errcode = 'restrict_violation';
  end if;
  return new;
end
$$`,
        )
        .execute(db);
      await sql
        .raw(
          `create trigger billing_plan_versions_immutable before update or delete on billing_plan_versions for each row execute function billing_plan_versions_guard()`,
        )
        .execute(db);
      return;
    }
    await sql
      .raw(
        `create trigger billing_plan_versions_never_deleted before delete on billing_plan_versions begin select raise(abort, '${MESSAGE}: a plan version is never deleted'); end`,
      )
      .execute(db);
    const changed = FROZEN_COLUMNS.map(
      (column) => `old.${column} is not new.${column}`,
    ).join(" or ");
    await sql
      .raw(
        `create trigger billing_plan_versions_terms_frozen before update on billing_plan_versions when ${changed} begin select raise(abort, '${MESSAGE}: a plan version changes only its role'); end`,
      )
      .execute(db);
  },

  async down(db) {
    if (databaseDriver(db) === "postgres") {
      await sql
        .raw(
          "drop trigger billing_plan_versions_immutable on billing_plan_versions",
        )
        .execute(db);
      await sql.raw("drop function billing_plan_versions_guard()").execute(db);
      return;
    }
    await sql
      .raw("drop trigger billing_plan_versions_terms_frozen")
      .execute(db);
    await sql
      .raw("drop trigger billing_plan_versions_never_deleted")
      .execute(db);
  },
};
