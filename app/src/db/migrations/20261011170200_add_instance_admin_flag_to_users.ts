// SPDX-License-Identifier: Apache-2.0

// `users.is_instance_admin`: the instance admin flag (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.3), a user flag that is separate from the roles in a workspace. 1 for the
// account the first-run setup creates, 0 for everybody else. Only the setup (and later the admin
// portal) sets it; Better Auth cannot, because the field is not an input.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("users")
      .addColumn("is_instance_admin", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();
  },
};
