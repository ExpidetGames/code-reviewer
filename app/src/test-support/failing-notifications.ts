// SPDX-License-Identifier: LicenseRef-Proprietary

// Failure injection for #506: a trigger that makes every write to `billing_notifications` fail. The
// decision whether a workspace is told about its balance is a side effect of money writes; with this installed a test proves
// that the money write (a charge, a settlement, a credit, a refund, a claim refusal) still commits while the notification is
// skipped. Nothing here touches any other table.
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

export async function failWritesToBalanceNotifications(
  db: Kysely<Database>,
): Promise<void> {
  await sql
    .raw(
      `create function fail_note() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$`,
    )
    .execute(db);
  await sql
    .raw(
      `create trigger fail_note_write before insert or update on billing_notifications for each row execute function fail_note()`,
    )
    .execute(db);
}
