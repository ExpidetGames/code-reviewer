// The ordered list of migrations. Kysely runs them in the alphabetical order of these keys, so
// every key after the first starts with a UTC timestamp, `YYYYMMDDHHMMSS_what_it_does`; "0001" sorts
// before all of them. A migration that has run is never edited: add a new one instead. Registered
// statically (not read from the disk) so it works in a Next.js bundle.
import type { Migration, MigrationProvider } from "kysely/migration";
import { migration as createAppMeta } from "./0001_create_app_meta.ts";
import { migration as createAuthTables } from "./20261010123800_create_auth_tables.ts";
import { migration as addUserOrgCheckedAt } from "./20261010125500_add_user_org_checked_at.ts";
import { migration as addUserOrgCheckedFor } from "./20261010131500_add_user_org_checked_for.ts";
import { migration as createAllowedLoginPins } from "./20261010133000_create_allowed_login_pins.ts";

const migrations: Record<string, Migration> = {
  "0001_create_app_meta": createAppMeta,
  "20261010123800_create_auth_tables": createAuthTables,
  "20261010125500_add_user_org_checked_at": addUserOrgCheckedAt,
  "20261010131500_add_user_org_checked_for": addUserOrgCheckedFor,
  "20261010133000_create_allowed_login_pins": createAllowedLoginPins,
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
