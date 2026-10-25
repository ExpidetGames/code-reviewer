// SPDX-License-Identifier: LicenseRef-Proprietary

// #499: a review refused for the monthly total limit or the hourly abuse brake gets a notice on its pull request, like the
// balance (#498), so the check on `refusal_notices.code` takes two more codes: `monthly_limit_reached` and
// `reviews_paused`. The list is `NOTICE_CODES` in the code.
//
// Postgres replaces the constraint. SQLite cannot change a check in place, and cannot drop a column a check names, so the
// table is rebuilt: a new one with the wider check gets every row, the old one is dropped (with its indexes) and the new one
// takes its name and its indexes back (the migration of #498 did the same). Nothing references `refusal_notices`.
//
// Safe next to a previous release: no column changes and every row survives. An older app instance never writes the new
// codes (it does not make the refusal that has them) and reads a row of them as a notice it does not know, which it does not
// post; upgrade every instance before billing is switched on.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

const OLD_CODES =
  "'quota_exhausted', 'workspace_suspended', 'insufficient_balance', 'balance_negative'";
const NEW_CODES = `${OLD_CODES}, 'monthly_limit_reached', 'reviews_paused'`;

async function createIndexes(db: Parameters<Migration["up"]>[0]) {
  await db.schema
    .createIndex("refusal_notices_pull_request_period")
    .on("refusal_notices")
    .columns(["workspace_id", "repository_id", "pr_number", "period_start"])
    .unique()
    .execute();
  await db.schema
    .createIndex("refusal_notices_due")
    .on("refusal_notices")
    .column("next_attempt_at")
    .where(sql.ref("state"), "=", "pending")
    .execute();
}

async function rebuild(db: Parameters<Migration["up"]>[0], codes: string) {
  await db.schema
    .createTable("refusal_notices_next")
    .addColumn("id", "text", (column) => column.primaryKey().notNull())
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references("workspaces.id"),
    )
    .addColumn("repository_id", "text", (column) =>
      column.notNull().references("repositories.id"),
    )
    .addColumn("pr_number", "integer", (column) => column.notNull())
    .addColumn("period_start", "text", (column) => column.notNull())
    .addColumn("code", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) =>
      column.notNull().defaultTo("pending"),
    )
    .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("next_attempt_at", "text", (column) => column.notNull())
    .addColumn("posted_at", "text")
    .addColumn("created_at", "text", (column) => column.notNull())
    .addColumn("updated_at", "text", (column) => column.notNull())
    .addCheckConstraint(
      "refusal_notices_state_check",
      sql`state in ('pending', 'posted', 'dropped')`,
    )
    .addCheckConstraint(
      "refusal_notices_code_check",
      sql.raw(`code in (${codes})`),
    )
    .addCheckConstraint(
      "refusal_notices_attempts_check",
      sql`attempts >= 0 and pr_number >= 1`,
    )
    .addCheckConstraint(
      "refusal_notices_posted_check",
      sql`(state = 'posted' and posted_at is not null) or (state <> 'posted' and posted_at is null)`,
    )
    .execute();
  await sql`insert into refusal_notices_next (id, workspace_id, repository_id, pr_number, period_start, code, state, attempts, next_attempt_at, posted_at, created_at, updated_at)
    select id, workspace_id, repository_id, pr_number, period_start, code, state, attempts, next_attempt_at, posted_at, created_at, updated_at from refusal_notices`.execute(
    db,
  );
  await db.schema.dropTable("refusal_notices").execute();
  await db.schema
    .alterTable("refusal_notices_next")
    .renameTo("refusal_notices")
    .execute();
  await createIndexes(db);
}

async function replaceConstraint(
  db: Parameters<Migration["up"]>[0],
  codes: string,
) {
  await sql`alter table refusal_notices drop constraint refusal_notices_code_check`.execute(
    db,
  );
  await sql
    .raw(
      `alter table refusal_notices add constraint refusal_notices_code_check check (code in (${codes}))`,
    )
    .execute(db);
}

export const migration: Migration = {
  async up(db) {
    if (databaseDriver(db) === "postgres")
      return replaceConstraint(db, NEW_CODES);
    await rebuild(db, NEW_CODES);
  },

  async down(db) {
    // Notices of the limits have no place in the narrower check: they are dropped, as the dedupe row of a refusal is only a
    // record that a comment was posted.
    await sql`delete from refusal_notices where code in ('monthly_limit_reached', 'reviews_paused')`.execute(
      db,
    );
    if (databaseDriver(db) === "postgres")
      return replaceConstraint(db, OLD_CODES);
    await rebuild(db, OLD_CODES);
  },
};
