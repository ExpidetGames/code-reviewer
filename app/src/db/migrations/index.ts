// The ordered list of migrations. Kysely runs them in the alphabetical order of these keys. `0001_*`
// is the first; every later key starts with a UTC timestamp `YYYYMMDDHHMMSS_` (parallel branches
// then never pick the same number). A migration that has run is never edited: add a new one instead.
// Registered statically (not read from the disk) so it works in a Next.js bundle.
import type { Migration, MigrationProvider } from "kysely/migration";
import { migration as createAppMeta } from "./0001_create_app_meta.ts";
import { migration as createIntegrations } from "./20261010120000_create_integrations.ts";
import { migration as createRepositories } from "./20261010143000_create_repositories.ts";

const migrations: Record<string, Migration> = {
  "0001_create_app_meta": createAppMeta,
  "20261010120000_create_integrations": createIntegrations,
  "20261010143000_create_repositories": createRepositories,
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
